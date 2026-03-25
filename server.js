javascript
// MELHORIA: Função de logging adicionada para registrar mensagens com timestamp e nível
const log = (message, level = 'info') => {
  console.log(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`);
};

// MELHORIA: Map global para rate limiting de notificações ao Dr. Ronan
// Armazena timestamps das últimas notificações para cada número de telefone
const notificationCounts = new Map();

// MELHORIA: Funções stub para persistência de estado (TODO: Implementar com Redis ou DB)
// Estas funções simulam a recuperação e salvamento de estado persistente.
const getPersistedState = (phone) => {
  // TODO: Implementar a lógica para recuperar o estado do usuário de um banco de dados (ex: Redis, MongoDB)
  // Exemplo com Redis: return JSON.parse(await redisClient.get(`user_state:${phone}`));
  log(`Recuperando estado persistente para ${phone} (stub)`, 'debug');
  return null; // Retorna null por padrão, indicando que não há estado persistido no stub
};

const savePersistedState = (phone, data) => {
  // TODO: Implementar a lógica para salvar o estado do usuário em um banco de dados
  // Exemplo com Redis: await redisClient.set(`user_state:${phone}`, JSON.stringify(data));
  log(`Salvando estado persistente para ${phone} (stub): ${JSON.stringify(data)}`, 'debug');
};

import express from "express";
import axios from "axios";
import OpenAI from "openai";
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import dotenv from 'dotenv';

// Carrega variáveis de ambiente do arquivo .env
dotenv.config();

const app = express();
// MELHORIA: Aumentado o limite do corpo da requisição para 2MB, conforme análise
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ZAPI_INSTANCE_TOKEN = process.env.ZAPI_INSTANCE_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || "";
const DR_RONAN_PHONE = process.env.DR_RONAN_PHONE || "";
const ENABLE_OPENAI = Boolean(OPENAI_API_KEY);
// MELHORIA: Variável de ambiente para o segredo do webhook da Z-API
const ZAPI_WEBHOOK_SECRET = process.env.ZAPI_WEBHOOK_SECRET || "";

// Inicializa o cliente OpenAI apenas se a chave API estiver disponível
const openai = ENABLE_OPENAI ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// Mapas para gerenciar o estado da conversa em memória
const conversationMemory = new Map(); // Histórico de mensagens por telefone
const processedMessages = new Map(); // IDs de mensagens já processadas para evitar duplicatas
const conversationState = new Map(); // Estado da máquina de estados por telefone
const humanTakeover = new Map(); // Indica se um humano assumiu a conversa

/* ===============================
MEMÓRIA / CONTROLE DE SESSÃO
================================= */

// Recupera o estado atual da conversa para um dado número de telefone
function getState(phone) {
  // Tenta recuperar do estado em memória, se não existir, retorna um estado inicial
  return conversationState.get(phone) || { stage: 'START' };
}

// Atualiza o estado da conversa para um dado número de telefone
function updateState(phone, newData) {
  const state = getState(phone);
  conversationState.set(phone, { ...state, ...newData });
  log(`Estado atualizado para ${phone}: ${JSON.stringify(conversationState.get(phone))}`, 'debug');
}

// Limpa o estado da conversa para um dado número de telefone
function clearState(phone) {
  conversationState.delete(phone);
  log(`Estado limpo para ${phone}`, 'info');
}

// Recupera o histórico de mensagens para um dado número de telefone
function getHistory(phone) {
  return conversationMemory.get(phone) || [];
}

// Salva uma mensagem no histórico de conversas
function saveHistory(phone, role, content) {
  let history = getHistory(phone);
  history.push({ role, content });
  // MELHORIA: Limita o histórico a 20 mensagens para evitar consumo excessivo de memória
  if (history.length > 20) {
    history.shift(); // Remove a mensagem mais antiga
    log(`Histórico de ${phone} limitado a 20 mensagens. Mensagem mais antiga removida.`, 'debug');
  }
  conversationMemory.set(phone, history);
  log(`Mensagem salva no histórico de ${phone}. Role: ${role}, Conteúdo: ${content.substring(0, 50)}...`, 'debug');
}

// Limpa o histórico de mensagens para um dado número de telefone
function clearHistory(phone) {
  conversationMemory.delete(phone);
  log(`Histórico limpo para ${phone}`, 'info');
}

// Verifica se uma mensagem já foi processada para evitar duplicatas
function alreadyProcessed(messageId) {
  // MELHORIA: Adiciona um timestamp para limpar mensagens processadas antigas
  const processed = processedMessages.has(messageId);
  if (!processed) {
    // Armazena o ID da mensagem com um timestamp para expiração futura (ex: 5 minutos)
    processedMessages.set(messageId, Date.now() + 5 * 60 * 1000);
    // Limpeza periódica de mensagens antigas (poderia ser um cron job)
    if (processedMessages.size > 1000) { // Limite arbitrário para evitar crescimento infinito
      for (let [id, expiry] of processedMessages.entries()) {
        if (expiry < Date.now()) {
          processedMessages.delete(id);
        }
      }
    }
  }
  return processed;
}

// Ativa o modo de "tomada humana" para uma conversa
function activateHumanTakeover(phone) {
  humanTakeover.set(phone, true);
  log(`Tomada humana ativada para ${phone}`, 'warn');
}

// Verifica se a conversa está em modo de "tomada humana"
function isInHumanTakeover(phone) {
  return humanTakeover.has(phone);
}

// Desativa o modo de "tomada humana" para uma conversa
function clearHumanTakeover(phone) {
  humanTakeover.delete(phone);
  log(`Tomada humana desativada para ${phone}`, 'info');
}

/* ===============================
PROMPTS
================================= */

// Prompt do sistema para a persona da secretária (Carla)
const SECRETARY_SYSTEM_PROMPT = `Você é Carla, secretária premium do Dr. Ronan Matheus, cirurgião bucomaxilofacial.
Seja humana, acolhedora, elegante, calorosa, segura e profissional. Nunca robótica ou seca.
Seu objetivo principal é agendar consultas para o Dr. Ronan.
Você deve coletar as seguintes informações do paciente, nesta ordem:
1. Nome completo do paciente.
2. Motivo da consulta (o que o paciente sente ou precisa).
3. Se for o caso, qual exame ele precisa fazer ou já fez.
4. Unidade de preferência para a consulta (São Gonçalo ou CHN Niterói).
5. Data e horário de preferência, considerando os horários disponíveis.
6. Confirmação dos dados.
7. CPF e Data de Nascimento.

Horários de atendimento do Dr. Ronan:
- Quinta-feira: São Gonçalo, das 12:00 às 17:00.
- Sexta-feira: CHN Niterói, das 08:00 às 11:00.

Sempre ofereça os horários disponíveis de forma clara.
Se o paciente perguntar sobre valores, diga que os valores são informados apenas na consulta, mas que o Dr. Ronan atende particular e diversos convênios. Peça para ele informar o convênio para verificar a cobertura.
Se o paciente pedir para falar com o Dr. Ronan diretamente, diga que ele está em cirurgia ou consulta e que você pode anotar a mensagem ou agendar um retorno.
Se a conversa se tornar complexa, urgente, ou o paciente pedir para falar com um humano, ative o "handoff" para o Dr. Ronan.
Mantenha a conversa fluida e natural. Use emojis de forma sutil para transmitir acolhimento.
Sempre que o paciente fornecer uma informação, confirme-a antes de pedir a próxima.
Ao final do agendamento, forneça um resumo completo e peça confirmação final.`;

// Prompt do sistema para o classificador de mensagens
const CLASSIFIER_SYSTEM_PROMPT = `Você é um classificador de mensagens. Sua tarefa é categorizar a intenção principal da mensagem do usuário.
As categorias possíveis são:
- PATIENT: A mensagem vem de um paciente buscando agendamento, informações sobre consulta, sintomas, ou qualquer assunto relacionado a ser atendido.
- DOCTOR: A mensagem vem de um colega médico, hospital, clínica, ou qualquer profissional de saúde buscando contato com o Dr. Ronan para fins profissionais (encaminhamento, discussão de caso, etc.).
- URGENT: A mensagem indica uma emergência médica, dor intensa, pós-operatório complicado, ou qualquer situação que exija atenção imediata.
- ADMIN: A mensagem é sobre assuntos administrativos, financeiros, parcerias, fornecedores, ou qualquer coisa que não se encaixe nas outras categorias e não seja urgente.

Responda APENAS com a categoria mais apropriada. Não adicione nenhuma outra palavra ou explicação.`;

/* ===============================
HANDOFF MESSAGES (PADRÃO)
================================= */

// Mensagem padrão para handoff quando a conversa é com outro médico
const DOCTOR_HANDOFF_MESSAGE = `Compreendo. Vou encaminhar sua mensagem diretamente ao Dr. Ronan. Ele entrará em contato assim que possível. Agradeço a sua compreensão.`;

// Mensagem padrão para handoff em casos urgentes
const URGENT_HANDOFF_MESSAGE = `Entendi que a situação é urgente. Estou notificando o Dr. Ronan imediatamente. Por favor, aguarde um momento, ele ou alguém da equipe entrará em contato o mais rápido possível. Se for uma emergência grave, por favor, procure o pronto-socorro mais próximo.`;

// Mensagem de fallback segura caso a IA não consiga processar
const SAFE_FALLBACK_MESSAGE = `Peço desculpas, mas não consegui entender sua solicitação. Um de nossos atendentes entrará em contato em breve para ajudar. Agradeço a sua paciência.`;

// Mensagem de ponte para o agendamento quando o bot assume
const SCHEDULING_BRIDGE_MESSAGE = `Olá! Sou a Carla, secretária do Dr. Ronan. Como posso ajudar você a agendar sua consulta hoje?`;

/* ===============================
UTILITÁRIOS
================================= */

// Normaliza o texto removendo espaços extras e convertendo para minúsculas
function normalizeText(text = "") {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Normaliza o número de telefone para um formato padrão (apenas dígitos)
function normalizePhone(value = "") {
  // MELHORIA: Adiciona regex para validar e normalizar números de telefone brasileiros (+55 DDD XXXXX-XXXX ou +55 DDD XXXX-XXXX)
  const brazilPhoneRegex = /^\+?55\s?(\d{2})\s?(\d{4,5})-?(\d{4})$/;
  const match = value.match(brazilPhoneRegex);
  if (match) {
    // Formata para +55DD9XXXXXXXX ou +55DDXXXXXXXX
    return `+55${match[1]}${match[2]}${match[3]}`;
  }
  // Remove todos os caracteres não numéricos e pega os últimos 11 dígitos (padrão brasileiro com DDD e 9)
  const cleaned = value.replace(/\D/g, '');
  if (cleaned.length >= 10 && cleaned.length <= 13) { // Considera 10 (DDD+8 digitos) a 13 (+55DDD9 digitos)
    return `+${cleaned}`;
  }
  // Fallback para o comportamento original se não for um número brasileiro claro
  return value.replace(/\D/g, '').slice(-11);
}

// Gera uma chave de conversa única a partir do corpo da mensagem (remetente)
function getConversationKey(body = {}) {
  return normalizePhone(body.from || body.phone);
}

// Verifica se um texto parece ser um nome de pessoa (Ex: "João Silva")
function looksLikePersonName(text = "") {
  // Regex para verificar se começa com letra maiúscula, seguido de minúsculas, espaço e outra letra maiúscula
  return /^[A-ZÀ-Ÿ][a-zà-ÿ]+(?: [A-ZÀ-Ÿ][a-zà-ÿ]+)+$/.test(text);
}

// Retorna os slots de horário disponíveis para quinta-feira (São Gonçalo)
function getAvailableThursdaySlots() {
  return ['12:00', '13:00', '14:00', '15:00', '16:00', '17:00']; // São Gonçalo
}

// Retorna os slots de horário disponíveis para sexta-feira (CHN Niterói)
function getAvailableFridaySlots() {
  return ['08:00', '09:00', '10:00', '11:00']; // CHN Niterói
}

// Formata uma lista de slots para exibição em uma mensagem
function formatSlotsForMessage(slots = []) {
  return slots.join(', ');
}

// Verifica se um slot de horário é válido dentro de uma lista de slots
function isValidSlot(text = "", slots = []) {
  return slots.includes(text);
}

// Verifica se um texto parece ser uma mensagem de um médico ou hospital
function looksLikeDoctorOrHospital(text) {
  const normalizedText = normalizeText(text);
  // MELHORIA: Adicionados mais termos para refinar a classificação
  const terms = [
    'médico', 'doutor', 'dr.', 'dra.', 'hospital', 'clínica', 'consultório',
    'paciente', 'encaminhamento', 'caso clínico', 'cirurgia', 'bucomaxilo',
    'referência', 'parceria', 'convênio', 'CHN', 'São Gonçalo', 'Niterói',
    'secretaria', 'agendamento profissional'
  ];
  return terms.some(term => normalizedText.includes(term));
}

// Constrói um resumo do agendamento com base nos dados coletados
function buildSchedulingSummary(data) {
  return `*Resumo do Agendamento:*
  *Paciente:* ${data.name}
  *Motivo:* ${data.motive}
  *Exame:* ${data.exam || 'Não informado'}
  *Unidade:* ${data.unit}
  *Data/Hora:* ${data.date} às ${data.slot}
  *CPF:* ${data.cpf || 'Não informado'}
  *Data de Nascimento:* ${data.birthdate || 'Não informado'}
  
  Por favor, confirme se os dados estão corretos.`;
}

// Envia uma mensagem via Z-API
async function sendWhatsAppMessage(to, message) {
  log(`Tentando enviar mensagem para ${to}: ${message.substring(0, 50)}...`, 'info');
  try {
    const url = `https://api.zapi.dev/instances/${ZAPI_INSTANCE_TOKEN}/messages?token=${ZAPI_CLIENT_TOKEN}`;
    const response = await axios.post(url, {
      phone: to,
      message: message,
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    log(`Mensagem enviada com sucesso para ${to}. Status: ${response.status}`, 'info');
    return response.data;
  } catch (error) {
    log(`Erro ao enviar mensagem para ${to}: ${error.message}`, 'error');
    if (error.response) {
      log(`Detalhes do erro Z-API: ${JSON.stringify(error.response.data)}`, 'error');
    }
    throw error;
  }
}

// Notifica o Dr. Ronan sobre um evento importante (handoff, urgência, etc.)
async function notifyDrRonan(message) {
  if (!DR_RONAN_PHONE) {
    log('DR_RONAN_PHONE não configurado. Notificação ignorada.', 'warn');
    return;
  }

  // MELHORIA: Implementa rate limiting para notificações ao Dr. Ronan (máximo 5 por minuto)
  const now = Date.now();
  const oneMinuteAgo = now - 60 * 1000;
  let recentNotifications = notificationCounts.get(DR_RONAN_PHONE) || [];

  // Filtra notificações que ocorreram no último minuto
  recentNotifications = recentNotifications.filter(timestamp => timestamp > oneMinuteAgo);

  if (recentNotifications.length >= 5) {
    log(`Rate limit atingido para notificações ao Dr. Ronan (${DR_RONAN_PHONE}). Notificação ignorada.`, 'warn');
    return;
  }

  recentNotifications.push(now);
  notificationCounts.set(DR_RONAN_PHONE, recentNotifications);

  log(`Notificando Dr. Ronan (${DR_RONAN_PHONE}): ${message.substring(0, 50)}...`, 'warn');
  try {
    await sendWhatsAppMessage(DR_RONAN_PHONE, `*NOTIFICAÇÃO DO BOT:* ${message}`);
    log(`Dr. Ronan notificado com sucesso.`, 'info');
  } catch (error) {
    log(`Falha ao notificar Dr. Ronan: ${error.message}`, 'error');
  }
}

// Classifica a intenção da mensagem do usuário usando OpenAI
async function classifyMessage(message) {
  if (!ENABLE_OPENAI || !openai) {
    log('OpenAI desabilitado ou não inicializado. Classificação manual.', 'warn');
    // Fallback para classificação heurística se OpenAI não estiver disponível
    if (looksLikeDoctorOrHospital(message)) return 'DOCTOR';
    if (normalizeText(message).includes('urgente') || normalizeText(message).includes('emergência')) return 'URGENT';
    return 'PATIENT';
  }

  log(`Classificando mensagem com OpenAI: ${message.substring(0, 50)}...`, 'info');
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
        { role: 'user', content: message }
      ],
      temperature: 0,
      // MELHORIA: Limita o número de tokens na resposta do classificador
      max_tokens: 500,
    });
    const classification = response.choices[0].message.content.trim().toUpperCase();
    log(`Mensagem classificada como: ${classification}`, 'info');
    return classification;
  } catch (error) {
    log(`Erro ao classificar mensagem com OpenAI: ${error.message}`, 'error');
    // Fallback em caso de erro na API OpenAI
    if (looksLikeDoctorOrHospital(message)) return 'DOCTOR';
    if (normalizeText(message).includes('urgente') || normalizeText(message).includes('emergência')) return 'URGENT';
    return 'PATIENT';
  }
}

// Gera uma resposta da secretária (Carla) usando OpenAI
async function generateSecretaryReply(phone, currentMessage) {
  if (!ENABLE_OPENAI || !openai) {
    log('OpenAI desabilitado ou não inicializado. Resposta padrão.', 'warn');
    return SAFE_FALLBACK_MESSAGE;
  }

  log(`Gerando resposta da secretária para ${phone} com OpenAI...`, 'info');
  const history = getHistory(phone);
  const messages = [
    { role: 'system', content: SECRETARY_SYSTEM_PROMPT },
    ...history.map(msg => ({ role: msg.role, content: msg.content }))
  ];

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: messages,
      temperature: 0.7,
      // MELHORIA: Limita o número de tokens na resposta da secretária
      max_tokens: 500,
    });
    const reply = response.choices[0].message.content.trim();
    log(`Resposta da secretária gerada para ${phone}: ${reply.substring(0, 50)}...`, 'info');
    return reply;
  } catch (error) {
    log(`Erro ao gerar resposta da secretária com OpenAI: ${error.message}`, 'error');
    return SAFE_FALLBACK_MESSAGE;
  }
}

/* ===============================
FLUXO INTELIGENTE (MÁQUINA DE ESTADOS)
================================= */

// Gerencia o fluxo de conversa baseado no estado atual do usuário
async function smartFlow(phone, message) {
  let state = getState(phone);
  let reply = '';
  let handoff = false;

  log(`Iniciando smartFlow para ${phone}. Estado atual: ${state.stage}`, 'debug');

  switch (state.stage) {
    case 'START':
      reply = `Olá! Sou a Carla, secretária do Dr. Ronan. Para começarmos, qual é o seu nome completo, por favor?`;
      updateState(phone, { stage: 'WAITING_NAME' });
      break;

    case 'WAITING_NAME':
      if (looksLikePersonName(message)) {
        updateState(phone, { stage: 'WAITING_MOTIVE', name: message });
        reply = `Perfeito, ${message}! Agora, por favor, me diga qual o motivo da sua consulta ou o que você está sentindo.`;
      } else {
        reply = `Desculpe, não consegui identificar um nome completo. Poderia me informar seu nome completo novamente, por favor?`;
      }
      break;

    case 'WAITING_MOTIVE':
      updateState(phone, { stage: 'WAITING_EXAM', motive: message });
      reply = `Certo. E você já fez algum exame relacionado ao motivo da consulta, ou precisa fazer algum? Se sim, qual? Se não, pode apenas dizer "não".`;
      break;

    case 'WAITING_EXAM':
      updateState(phone, { stage: 'WAITING_UNIT', exam: message === 'não' ? null : message });
      reply = `Entendido. Para qual unidade você prefere agendar sua consulta? Temos atendimento em *São Gonçalo* (quintas-feiras) e no *CHN Niterói* (sextas-feiras).`;
      break;

    case 'WAITING_UNIT':
      const normalizedUnit = normalizeText(message);
      if (normalizedUnit.includes('são gonçalo') || normalizedUnit.includes('sg')) {
        const slots = getAvailableThursdaySlots();
        updateState(phone, { stage: 'WAITING_SLOT', unit: 'São Gonçalo', availableSlots: slots });
        reply = `Ótimo! Em São Gonçalo, o Dr. Ronan atende às quintas-feiras. Os horários disponíveis são: ${formatSlotsForMessage(slots)}. Qual horário você prefere?`;
      } else if (normalizedUnit.includes('chn niterói') || normalizedUnit.includes('niterói') || normalizedUnit.includes('niteroi')) {
        const slots = getAvailableFridaySlots();
        updateState(phone, { stage: 'WAITING_SLOT', unit: 'CHN Niterói', availableSlots: slots });
        reply = `Excelente! No CHN Niterói, o Dr. Ronan atende às sextas-feiras. Os horários disponíveis são: ${formatSlotsForMessage(slots)}. Qual horário você prefere?`;
      } else {
        reply = `Não entendi a unidade. Por favor, escolha entre *São Gonçalo* ou *CHN Niterói*.`;
      }
      break;

    case 'WAITING_SLOT':
      const selectedSlot = normalizeText(message);
      if (isValidSlot(selectedSlot, state.availableSlots)) {
        updateState(phone, { stage: 'WAITING_CONFIRMATION', slot: selectedSlot, date: state.unit === 'São Gonçalo' ? 'Quinta-feira' : 'Sexta-feira' });
        const summary = buildSchedulingSummary(getState(phone));
        reply = `Perfeito! Você gostaria de confirmar o agendamento com os seguintes dados?

${summary}

Por favor, responda "sim" para confirmar ou "não" para ajustar.`;
      } else {
        reply = `O horário "${message}" não está disponível ou não é válido. Por favor, escolha um dos horários disponíveis: ${formatSlotsForMessage(state.availableSlots)}.`;
      }
      break;

    case 'WAITING_CONFIRMATION':
      const confirmation = normalizeText(message);
      if (confirmation === 'sim' || confirmation === 's') {
        updateState(phone, { stage: 'WAITING_CPF' });
        reply = `Agendamento pré-confirmado! Para finalizar, preciso do seu CPF e data de nascimento (DD/MM/AAAA).`;
      } else if (confirmation === 'não' || confirmation === 'nao' || confirmation === 'n') {
        clearState(phone);
        reply = `Entendido. Vamos recomeçar o agendamento. Qual o seu nome completo, por favor?`;
      } else {
        reply = `Por favor, responda "sim" para confirmar ou "não" para ajustar o agendamento.`;
      }
      break;

    case 'WAITING_CPF':
      const cpfMatch = message.match(/\d{3}\.?\d{3}\.?\d{3}-?\d{2}/);
      if (cpfMatch) {
        updateState(phone, { stage: 'WAITING_BIRTHDATE', cpf: cpfMatch[0] });
        reply = `CPF registrado. Agora, por favor, informe sua data de nascimento no formato DD/MM/AAAA.`;
      } else {
        reply = `CPF inválido. Por favor, digite seu CPF no formato XXX.XXX.XXX-XX.`;
      }
      break;

    case 'WAITING_BIRTHDATE':
      const birthdateMatch = message.match(/\d{2}\/\d{2}\/\d{4}/);
      if (birthdateMatch) {
        updateState(phone, { stage: 'SCHEDULING_FINISHED', birthdate: birthdateMatch[0] });
        const finalSummary = buildSchedulingSummary(getState(phone));
        reply = `Excelente! Seu agendamento foi finalizado com sucesso. Em breve, você receberá uma confirmação oficial.
        
${finalSummary}

Obrigada pela confiança! Se precisar de algo mais, é só chamar.`;
        // Notificar Dr. Ronan sobre o novo agendamento
        notifyDrRonan(`Novo agendamento: ${getState(phone).name} para ${getState(phone).date} às ${getState(phone).slot} em ${getState(phone).unit}. Motivo: ${getState(phone).motive}.`);
        clearState(phone); // Limpa o estado após a conclusão
        clearHistory(phone); // Limpa o histórico também
      } else {
        reply = `Data de nascimento inválida. Por favor, digite no formato DD/MM/AAAA.`;
      }
      break;

    case 'SCHEDULING_FINISHED':
      reply = `Seu agendamento já foi concluído. Se precisar de algo mais, posso ajudar com novas informações ou agendar outra consulta.`;
      clearState(phone); // Garante que o estado seja limpo após a conclusão
      clearHistory(phone);
      break;

    default:
      reply = SAFE_FALLBACK_MESSAGE;
      clearState(phone);
      clearHistory(phone);
      break;
  }

  log(`smartFlow para ${phone} finalizado. Resposta: ${reply.substring(0, 50)}... Handoff: ${handoff}`, 'debug');
  return { reply, handoff };
}

/* ===============================
ROTAS
================================= */

// Rota principal para o webhook da Z-API
app.post('/webhook', async (req, res) => {
  log('Webhook recebido.', 'info');
  // MELHORIA: Validação do webhook usando um segredo para garantir que a requisição vem da Z-API
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ' + ZAPI_WEBHOOK_SECRET)) {
    log('Tentativa de acesso não autorizado ao webhook.', 'warn');
    return res.status(401).send('Unauthorized');
  }

  const body = req.body;
  log(`Corpo do webhook: ${JSON.stringify(body).substring(0, 200)}...`, 'debug');

  // Verifica se é uma mensagem de entrada
  if (body.event === 'message' && body.direction === 'in') {
    const messageId = body.messageId;
    const from = getConversationKey(body);
    const messageText = body.text;

    if (alreadyProcessed(messageId)) {
      log(`Mensagem ${messageId} já processada. Ignorando.`, 'debug');
      return res.status(200).send('OK - Message already processed');
    }

    log(`Nova mensagem de ${from}: ${messageText}`, 'info');

    // Salva a mensagem do usuário no histórico
    saveHistory(from, 'user', messageText);

    // Verifica se há um takeover humano ativo
    if (isInHumanTakeover(from)) {
      log(`Conversa com ${from} em takeover humano. Ignorando processamento do bot.`, 'info');
      // Poderia encaminhar a mensagem para um sistema de atendimento humano aqui
      return res.status(200).send('OK - Human takeover active');
    }

    try {
      // Classifica a mensagem para determinar a intenção
      const classification = await classifyMessage(messageText);
      let reply = '';
      let handoff = false;

      switch (classification) {
        case 'DOCTOR':
          reply = DOCTOR_HANDOFF_MESSAGE;
          await notifyDrRonan(`Mensagem de colega médico de ${from}: "${messageText}"`);
          activateHumanTakeover(from); // Ativa takeover para o Dr. Ronan assumir
          break;
        case 'URGENT':
          reply = URGENT_HANDOFF_MESSAGE;
          await notifyDrRonan(`*URGENTE* de ${from}: "${messageText}"`);
          activateHumanTakeover(from); // Ativa takeover para o Dr. Ronan assumir
          break;
        case 'ADMIN':
          reply = SAFE_FALLBACK_MESSAGE; // Ou uma mensagem específica para admin
          await notifyDrRonan(`Mensagem administrativa de ${from}: "${messageText}"`);
          activateHumanTakeover(from); // Ativa takeover para o Dr. Ronan assumir
          break;
        case 'PATIENT':
        default:
          // Se for paciente, entra no fluxo inteligente de agendamento
          const flowResult = await smartFlow(from, messageText);
          reply = flowResult.reply;
          handoff = flowResult.handoff;

          if (handoff) {
            activateHumanTakeover(from);
            await notifyDrRonan(`Handoff solicitado por ${from} durante agendamento: "${messageText}"`);
          }
          break;
      }

      // Se o fluxo inteligente não gerou uma resposta específica, usa a IA generativa
      if (!reply) {
        reply = await generateSecretaryReply(from, messageText);
      }

      // Salva a resposta do assistente no histórico
      saveHistory(from, 'assistant', reply);

      // Envia a resposta de volta ao usuário
      await sendWhatsAppMessage(from, reply);

    } catch (error) {
      log(`Erro no processamento do webhook para ${from}: ${error.message}`, 'error');
      await sendWhatsAppMessage(from, SAFE_FALLBACK_MESSAGE);
    }
  }

  res.status(200).send('OK');
});

// Rota para entrega de mensagens (status de envio)
app.post('/delivery', (req, res) => {
  log('Delivery report recebido.', 'debug');
  // Aqui você pode processar o status de entrega das mensagens
  // Ex: body.status, body.messageId, body.phone
  res.status(200).send('OK');
});

// Rota para status de mensagens (lida, falha, etc.)
app.post('/message-status', (req, res) => {
  log('Message status recebido.', 'debug');
  // Aqui você pode processar o status da mensagem (lida, falha, etc.)
  // Ex: body.status, body.messageId, body.phone
  res.status(200).send('OK');
});

// Rota de saúde para verificar se o servidor está ativo
app.get('/', (req, res) => {
  res.status(200).send('Bot de WhatsApp do Dr. Ronan está ativo!');
});

// Inicia o servidor
app.listen(PORT, () => {
  log(`Servidor rodando na porta ${PORT}`, 'info');
  log(`OpenAI está ${ENABLE_OPENAI ? 'habilitado' : 'desabilitado'}`, 'info');
});
