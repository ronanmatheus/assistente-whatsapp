import express from "express";
import axios from "axios";
import OpenAI from "openai";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ZAPI_INSTANCE_TOKEN = process.env.ZAPI_INSTANCE_TOKEN;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || "";
const DR_RONAN_PHONE = process.env.DR_RONAN_PHONE || "";
const ENABLE_OPENAI = Boolean(OPENAI_API_KEY);

const openai = ENABLE_OPENAI
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

/* ===============================
   MEMÓRIA / CONTROLE DE SESSÃO
================================= */

const conversationMemory = new Map();
const processedMessages = new Map();
const conversationState = new Map();
const humanTakeover = new Map();

function getState(conversationKey) {
  return conversationState.get(conversationKey) || {
    stage: "START",
    name: null,
    reason: null,
    hasExam: null,
    unit: null,
    selectedSlot: null,
    cpf: null,
    birthDate: null
  };
}

function updateState(conversationKey, newData) {
  const current = getState(conversationKey);
  const updated = { ...current, ...newData };
  conversationState.set(conversationKey, updated);
}

function clearState(conversationKey) {
  conversationState.delete(conversationKey);
}

function getHistory(conversationKey) {
  return conversationMemory.get(conversationKey) || [];
}

function saveHistory(conversationKey, role, content) {
  const history = conversationMemory.get(conversationKey) || [];
  history.push({ role, content });

  if (history.length > 14) {
    history.splice(0, history.length - 14);
  }

  conversationMemory.set(conversationKey, history);
}

function clearHistory(conversationKey) {
  conversationMemory.delete(conversationKey);
}

function alreadyProcessed(messageId) {
  if (!messageId) return false;

  const now = Date.now();
  const existing = processedMessages.get(messageId);

  if (existing && now - existing < 1000 * 60 * 30) {
    return true;
  }

  processedMessages.set(messageId, now);

  if (processedMessages.size > 1000) {
    for (const [key, value] of processedMessages.entries()) {
      if (now - value > 1000 * 60 * 60) {
        processedMessages.delete(key);
      }
    }
  }

  return false;
}

function activateHumanTakeover(phone) {
  if (!phone) return;
  humanTakeover.set(phone, Date.now());
}

function isInHumanTakeover(phone) {
  const startedAt = humanTakeover.get(phone);
  if (!startedAt) return false;

  const now = Date.now();

  // 1 hora de bloqueio
  if (now - startedAt < 1000 * 60 * 60) {
    return true;
  }

  humanTakeover.delete(phone);
  return false;
}

function clearHumanTakeover(phone) {
  humanTakeover.delete(phone);
}

/* ===============================
   PROMPTS
================================= */
const SECRETARY_SYSTEM_PROMPT = `
Você é Carla, secretária premium do Dr. Ronan Matheus, cirurgião bucomaxilofacial.

Você atende pacientes pelo WhatsApp com linguagem humana, acolhedora, elegante, calorosa, segura e extremamente profissional.

Seu objetivo é fazer o paciente se sentir bem recebido, compreendido, seguro e conduzido com naturalidade até o agendamento.

ESTILO DE COMUNICAÇÃO:
- sempre humana e natural
- acolhedora e simpática
- elegante, leve e profissional
- calorosa, sem exagero
- nunca robótica
- nunca seca
- use o nome do paciente sempre que possível
- use no máximo 1 emoji suave quando fizer sentido
- escreva como uma secretária real de clínica premium
- varie o texto para não parecer repetitiva
- evite perguntas frias e mecânicas

COMO RESPONDER:
Toda resposta deve, sempre que possível, ter esta estrutura natural:
1. acolhimento
2. validação ou conexão com o que a pessoa disse
3. direcionamento para o próximo passo

REGRAS IMPORTANTES:
- nunca faça diagnóstico
- nunca prescreva medicamentos
- nunca substitua avaliação médica
- nunca invente informação
- nunca diga que é IA
- nunca fale como robô
- nunca use linguagem excessivamente técnica com pacientes
- nunca seja seca, direta demais ou ríspida
- não transforme a conversa em interrogatório
- faça só uma pergunta por vez
- sempre conduza a conversa com delicadeza

REGRAS DE HANDOFF:
Só interrompa o fluxo e encaminhe diretamente ao Dr. Ronan se a mensagem indicar claramente:
- colega médico
- contato hospitalar
- sobreaviso
- parecer
- interconsulta
- CTI
- enfermaria
- centro cirúrgico
- urgência clínica real

Muito importante:
- mencionar "Dr. Ronan", "doutor", "consulta com ele", "quero operar com ele", "quais dias ele atende" ou frases semelhantes NÃO significa contato profissional
- nesses casos, siga normalmente o fluxo de secretária e responda ao paciente
- não encaminhe ao Dr. Ronan apenas porque o nome dele foi citado

AGENDA FIXA:
- o Dr. Ronan atende às quintas-feiras, das 12h às 17h, no consultório em São Gonçalo
- o Dr. Ronan atende às sextas-feiras, das 08h às 11h, no CHN em Niterói
- quando o paciente perguntar os dias de atendimento, responda objetivamente com essas informações
- quando o paciente perguntar o endereço, informe que pode enviar a localização certinha no momento do agendamento
- não invente endereço se ele não estiver explicitamente disponível no contexto
- se o paciente demonstrar interesse, conduza imediatamente para o agendamento

SOBRE CONVÊNIOS:
- se o paciente perguntar sobre convênio, responda de forma acolhedora e explicativa
- convênio odontológico não é atendido
- quando houver plano de saúde médico, explique que em alguns casos conseguimos conduzir em ambiente hospitalar, quando indicado
- mantenha tom positivo e resolutivo

EXEMPLOS DE TOM IDEAL:

"Olá, Adrielly! 😊 Que bom te receber por aqui.

Vai ser um prazer te ajudar.

Entendi o seu caso, e é ótimo que você já tenha a radiografia, isso ajuda bastante na avaliação.

Sobre o plano, nós não atendemos pelo convênio odontológico, mas quando há plano de saúde médico, conseguimos conduzir o tratamento em ambiente hospitalar, quando indicado.

Se você quiser, já posso organizar os próximos passos por aqui 💙"

"Perfeito, João! 😊 Obrigada por me explicar.

Para eu te direcionar da melhor forma, me conta só mais uma coisinha..."

"Claro! O Dr. Ronan atende às quintas-feiras, das 12h às 17h, no consultório em São Gonçalo, e às sextas-feiras, das 08h às 11h, no CHN em Niterói.

Se você quiser, eu já posso seguir com o seu agendamento por aqui."

RESPOSTA DE HANDOFF PROFISSIONAL:
Se realmente for contato profissional ou hospitalar, responda apenas:
"Recebi sua mensagem. Estou encaminhando isso imediatamente e diretamente ao Dr. Ronan."

OBJETIVO FINAL:
- acolher
- gerar confiança
- conduzir
- converter para atendimento/agendamento
- fazer o paciente sentir que está sendo bem cuidado desde a primeira mensagem
`;

const CLASSIFIER_SYSTEM_PROMPT = `
Classifique a mensagem em apenas uma categoria. Responda somente com uma destas palavras:

PATIENT
DOCTOR
URGENT
ADMIN

Critérios:
- DOCTOR = colega médico, dentista, equipe hospitalar, sobreaviso, CHN, parecer, interconsulta, CTI, enfermaria, centro cirúrgico, avaliação hospitalar, discussão de caso
- URGENT = sinais de gravidade, piora importante, trauma facial relevante, falta de ar, sangramento importante, edema progressivo, febre alta com piora
- ADMIN = assuntos administrativos puros, como endereço, convênio, horário, documentação, valor, retorno burocrático
- PATIENT = paciente geral, primeira consulta, retorno, pós-operatório sem gravidade, exame, dor, agendamento
`;

/* ===============================
   HANDOFF MESSAGES (PADRÃO)
================================= */

const DOCTOR_HANDOFF_MESSAGE =
  "Recebi sua mensagem. Estou encaminhando isso imediatamente e diretamente ao Dr. Ronan.";

const URGENT_HANDOFF_MESSAGE =
  "Entendi. Pelo que você me relatou, isso precisa de atenção mais rápida. Vou encaminhar sua mensagem com prioridade ao Dr. Ronan agora.";

const SAFE_FALLBACK_MESSAGE =
  "Recebi sua mensagem e vou te ajudar por aqui. Para eu te direcionar da melhor forma, me informe por favor seu nome completo e o motivo principal do seu contato.";

const SCHEDULING_BRIDGE_MESSAGE =
  "Perfeito. Vou te ajudar com isso. Me informe por favor seu nome completo e o motivo principal da consulta.";

/* ===============================
   UTILITÁRIOS
================================= */

function normalizeText(text = "") {
  return String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function normalizePhone(value = "") {
  return String(value).replace(/\D/g, "");
}

function getConversationKey(body = {}) {
  return String(
    body?.chatLid ||
    body?.chatId ||
    body?.phone ||
    ""
  ).trim();
}
function looksLikePersonName(text = "") {
  const value = normalizeText(text);

  if (!value) return false;

  const blocked = [
    "ok",
    "okay",
    "ola",
    "oi",
    "bom dia",
    "boa tarde",
    "boa noite",
    "sim",
    "nao",
    "não",
    "esta bem",
    "está bem",
    "tudo bem",
    "quero marcar uma consulta",
    "consulta",
    "quero marcar",
    "amil",
    "plano",
    "nao tenho",
    "não tenho",
    "manha",
    "manhã",
    "tarde"
  ];

  if (blocked.includes(value)) return false;

  const parts = value.split(" ").filter(Boolean);

  if (parts.length < 2) return false;

  return parts.every(part => /^[a-zà-ÿ]+$/i.test(part));
}

function getAvailableThursdaySlots() {
  return [
    "12:00",
    "12:30",
    "13:00",
    "13:30",
    "14:00",
    "14:30",
    "15:00",
    "15:30",
    "16:00",
    "16:30"
  ];
}

function getAvailableFridaySlots() {
  return [
    "08:00",
    "08:30",
    "09:00",
    "09:30",
    "10:00",
    "10:30"
  ];
}

function formatSlotsForMessage(slots = []) {
  return slots.map(slot => `• ${slot}`).join("\n");
}

function isValidSlot(text = "", slots = []) {
  const normalized = String(text).trim();
  return slots.includes(normalized);
}

function looksLikeDoctorOrHospital(text) {
  const t = normalizeText(text);

  const doctorContextTerms = [
    "colega medico",
    "colega medica",
    "sou medico",
    "sou medica",
    "equipe medica",
    "sobreaviso",
    "plantao",
    "parecer",
    "interconsulta",
    "avaliacao hospitalar",
    "cti",
    "uti",
    "enfermaria",
    "centro cirurgico",
    "pronto socorro",
    "trauma de face",
    "fratura de face",
    "hospital",
    "chn"
  ];

  return doctorContextTerms.some(term => t.includes(term));
}

function looksUrgent(text) {
  const t = normalizeText(text);

  const terms = [
    "falta de ar",
    "dificuldade para respirar",
    "nao consigo respirar",
    "muito sangramento",
    "sangramento intenso",
    "sangrando muito",
    "inchaco aumentando",
    "edema progressivo",
    "febre alta",
    "trauma",
    "acidente",
    "batida",
    "queda",
    "muito inchado",
    "dor insuportavel",
    "nao consigo abrir a boca",
    "pus",
    "secrecao",
    "desmaiou",
    "confusao"
  ];

  return terms.some(term => t.includes(term));
}

async function classifyMessage(message) {
  if (!ENABLE_OPENAI) {
    if (looksLikeDoctorOrHospital(message)) return "DOCTOR";
    if (looksUrgent(message)) return "URGENT";
    return "PATIENT";
  }

  try {
    const response = await openai.responses.create({
      model: "gpt-5.4-mini",
      input: [
        { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
        { role: "user", content: message }
      ]
    });

    const result = (response.output_text || "").trim().toUpperCase();

    if (["PATIENT", "DOCTOR", "URGENT", "ADMIN"].includes(result)) {
      return result;
    }

    if (looksLikeDoctorOrHospital(message)) return "DOCTOR";
    if (looksUrgent(message)) return "URGENT";
    return "PATIENT";
  } catch (error) {
    console.error("Erro ao classificar mensagem:", error.response?.data || error.message);
    if (looksLikeDoctorOrHospital(message)) return "DOCTOR";
    if (looksUrgent(message)) return "URGENT";
    return "PATIENT";
  }
}

async function sendWhatsAppMessage(instanceId, phone, message) {
  const normalizedPhone = normalizePhone(phone);

  if (!normalizedPhone) {
    throw new Error(`Telefone inválido para envio: ${phone}`);
  }

  const url = `https://api.z-api.io/instances/${instanceId}/token/${ZAPI_INSTANCE_TOKEN}/send-text`;

  const headers = {
    "Content-Type": "application/json"
  };

  if (ZAPI_CLIENT_TOKEN) {
    headers["Client-Token"] = ZAPI_CLIENT_TOKEN;
  }

  console.log("Enviando resposta para:", url);

  const result = await axios.post(
    url,
    {
      phone: normalizedPhone,
      message
    },
    { headers }
  );

  console.log("✅ Resposta enviada com sucesso");
  return result.data;
}

async function notifyDrRonan(instanceId, originalPhone, senderName, originalMessage, reasonLabel) {
  if (!DR_RONAN_PHONE) {
    console.log("⚠️ DR_RONAN_PHONE não configurado. Encaminhamento interno não enviado.");
    return;
  }

  const forwardText =
    `Encaminhamento prioritário para o Dr. Ronan\n\n` +
    `Motivo: ${reasonLabel}\n` +
    `Remetente: ${senderName || "Não identificado"}\n` +
    `Telefone: ${originalPhone}\n` +
    `Mensagem:\n${originalMessage}`;

  try {
    await sendWhatsAppMessage(instanceId, DR_RONAN_PHONE, forwardText);
    console.log("✅ Encaminhamento ao Dr. Ronan enviado");
  } catch (error) {
    console.error("Erro ao encaminhar para Dr. Ronan:", error.response?.data || error.message);
  }
}

async function generateSecretaryReply(phone, message) {
  if (!ENABLE_OPENAI) {
    return "Olá! Vou te ajudar por aqui. Me informe por favor seu nome completo e o motivo principal do seu contato.";
  }

  const history = getHistory(phone);

  const input = [
    {
      role: "system",
      content: SECRETARY_SYSTEM_PROMPT
    },
    ...history.map(item => ({
      role: item.role,
      content: item.content
    })),
    {
      role: "user",
      content: message
    }
  ];

  const response = await openai.responses.create({
    model: "gpt-5.4-mini",
    input
  });

  const reply =
    response.output_text?.trim() ||
    "Olá! Vou te ajudar por aqui. Me informe por favor seu nome completo e o motivo principal do seu contato.";

  return reply;
}

async function smartFlow(conversationKey, phone, message) {
  const state = getState(conversationKey);
  const text = normalizeText(message);

  if (
    text.includes("amil") ||
    text.includes("plano") ||
    text.includes("convenio") ||
    text.includes("convênio")
  ) {
    return "Claro! Sobre plano, nós não atendemos por convênio odontológico. Quando há plano de saúde médico, em alguns casos conseguimos conduzir o tratamento em ambiente hospitalar, quando indicado. Se você quiser, me conta melhor o que você precisa para eu te orientar da melhor forma.";
  }

  if (
    text.includes("quais dias") ||
    text.includes("que dias") ||
    text.includes("quando ele atende") ||
    text.includes("dias que atende") ||
    text.includes("dias de atendimento")
  ) {
    return "Claro! O Dr. Ronan atende às quintas-feiras, das 12h às 17h, no consultório em São Gonçalo, e às sextas-feiras, das 08h às 11h, no CHN em Niterói. Se você quiser, eu já posso seguir com o seu agendamento por aqui.";
  }

if (state.stage === "START") {
  updateState(conversationKey, { stage: "WAITING_NAME" });
  return await generateStageReply(conversationKey, phone, message, "ASK_NAME");
}

if (state.stage === "WAITING_NAME") {
  if (!looksLikePersonName(message)) {
    return "Perfeito 😊 Me informa, por favor, seu nome completo para eu seguir com seu atendimento.";
  }

  updateState(conversationKey, {
    stage: "WAITING_REASON",
    name: message
  });

  return await generateStageReply(conversationKey, phone, message, "ASK_REASON");
}

if (state.stage === "WAITING_REASON") {
  updateState(conversationKey, {
    stage: "WAITING_EXAM",
    reason: message
  });

  return await generateStageReply(conversationKey, phone, message, "ASK_EXAM");
}

if (state.stage === "WAITING_EXAM") {
  updateState(conversationKey, {
    stage: "READY_TO_SCHEDULE",
    hasExam: message
  });

  return await generateStageReply(conversationKey, phone, message, "ASK_PERIOD");
}

  if (state.stage === "READY_TO_SCHEDULE") {
  const text = normalizeText(message);

  if (text.includes("sao goncalo") || text.includes("são gonçalo")) {
    const slots = getAvailableThursdaySlots();

    updateState(conversationKey, {
      stage: "WAITING_SLOT",
      unit: "SAO_GONCALO"
    });

    return `Perfeito! 😊

Para atendimento em São Gonçalo, na quinta-feira, tenho estes horários disponíveis:

${formatSlotsForMessage(slots)}

Me informe, por favor, qual horário você prefere.`;
  }

if (state.stage === "WAITING_SLOT") {
  const selectedUnit = state.unit;

  const availableSlots =
    selectedUnit === "SAO_GONCALO"
      ? getAvailableThursdaySlots()
      : getAvailableFridaySlots();

  if (!isValidSlot(message, availableSlots)) {
    return `Tudo bem 😊 Me informe, por favor, um dos horários disponíveis abaixo:

${formatSlotsForMessage(availableSlots)}`;
  }

  const normalizedSlot = normalizeSlotInput(message);

  updateState(conversationKey, {
    stage: "WAITING_CPF",
    selectedSlot: normalizedSlot
  });

  const unitLabel =
    selectedUnit === "SAO_GONCALO"
      ? "São Gonçalo, na quinta-feira"
      : "CHN em Niterói, na sexta-feira";

  return `Perfeito! 😊

Seu horário escolhido foi ${normalizedSlot} para atendimento em ${unitLabel}.

Agora me envie, por favor, seu CPF para eu seguir com o agendamento.`;
}

if (state.stage === "WAITING_CPF") {
  updateState(conversationKey, {
    stage: "WAITING_BIRTHDATE",
    cpf: message.trim()
  });

  return `Perfeito 😊

Agora me envie, por favor, sua data de nascimento no formato DD/MM/AAAA para eu concluir seu agendamento.`;
}

    if (state.stage === "WAITING_BIRTHDATE") {
  updateState(conversationKey, {
    stage: "SCHEDULING_FINISHED",
    birthDate: message.trim()
  });

  const finalState = getState(conversationKey);

  const unitLabel =
    finalState.unit === "SAO_GONCALO"
      ? "São Gonçalo"
      : "CHN Niterói";

  const dayLabel =
    finalState.unit === "SAO_GONCALO"
      ? "quinta-feira"
      : "sexta-feira";

  return {
    type: "FINAL_SCHEDULING",
    patientMessage: `Perfeito! 😊

Seu agendamento foi registrado com sucesso.

Consulta agendada para ${dayLabel}, às ${finalState.selectedSlot}, em ${unitLabel}.

Em breve você receberá a confirmação final por aqui.`,
    internalSummary:
      `Novo agendamento solicitado\n\n` +
      `Paciente: ${finalState.name || "Não informado"}\n` +
      `Telefone: ${normalizePhone(conversationKey)}\n` +
      `Motivo: ${finalState.reason || "Não informado"}\n` +
      `Exames: ${finalState.hasExam || "Não informado"}\n` +
      `Unidade: ${unitLabel}\n` +
      `Dia: ${dayLabel}\n` +
      `Horário: ${finalState.selectedSlot || "Não informado"}\n` +
      `CPF: ${finalState.cpf || "Não informado"}\n` +
      `Nascimento: ${finalState.birthDate || "Não informado"}`
  };
}
    

function buildSchedulingSummary(state, patientData, patientPhone) {
  const unitLabel =
    state.unit === "SAO_GONCALO"
      ? "São Gonçalo"
      : "CHN Niterói";

  const dayLabel =
    state.unit === "SAO_GONCALO"
      ? "Quinta-feira"
      : "Sexta-feira";

  return (
    `Novo agendamento solicitado\n\n` +
    `Paciente: ${state.name || "Não informado"}\n` +
    `Telefone: ${patientPhone}\n` +
    `Motivo: ${state.reason || "Não informado"}\n` +
    `Exames: ${state.hasExam || "Não informado"}\n` +
    `Unidade: ${unitLabel}\n` +
    `Dia: ${dayLabel}\n` +
    `Horário: ${state.selectedSlot || "Não informado"}\n\n` +
    `Dados enviados pelo paciente:\n${patientData}`
  );
}

  if (text.includes("chn") || text.includes("niteroi") || text.includes("niterói")) {
    const slots = getAvailableFridaySlots();

    updateState(conversationKey, {
      stage: "WAITING_SLOT",
      unit: "CHN"
    });

    return `Perfeito! 😊

Para atendimento no CHN, em Niterói, na sexta-feira, tenho estes horários disponíveis:

${formatSlotsForMessage(slots)}

Me informe, por favor, qual horário você prefere.`;
  }

if (state.stage === "SLOT_CONFIRMED") {
  const patientData = message.trim();

  const summary = buildSchedulingSummary(state, patientData, phone);

  updateState(conversationKey, {
    stage: "SCHEDULING_FINISHED",
    patientData
  });

  return {
    type: "FINAL_SCHEDULING",
    patientMessage: `Perfeito! 😊

Recebi seus dados e já vou deixar seu atendimento encaminhado para continuidade do agendamento.

Em breve você receberá a confirmação certinha por aqui.`,
    internalSummary: summary
  };
}
    
  return "Perfeito 😊 Para eu seguir com o seu agendamento, me confirme por favor se você prefere atendimento em São Gonçalo ou no CHN em Niterói.";
}

  return SAFE_FALLBACK_MESSAGE;
}

async function generateStageReply(conversationKey, phone, message, stageInstruction) {
  const state = getState(conversationKey);

  if (!ENABLE_OPENAI) {
    if (stageInstruction === "ASK_NAME") {
      return "Olá! Seja bem-vindo(a). Vou te ajudar por aqui. Me informe por favor seu nome completo.";
    }

    if (stageInstruction === "ASK_REASON") {
      return `Perfeito, ${state.name || "tudo bem"}. Me conta por favor qual é o motivo principal do seu contato.`;
    }

    if (stageInstruction === "ASK_EXAM") {
      return "Entendi. Você já possui algum exame relacionado a isso, como radiografia, tomografia ou ressonância?";
    }

    if (stageInstruction === "ASK_PERIOD") {
      return "Perfeito. Vou organizar isso para você. Qual período costuma ser melhor para seu atendimento, manhã ou tarde?";
    }

    if (stageInstruction === "FORWARD_SCHEDULING") {
      return "Ótimo. Vou encaminhar seu atendimento agora para a equipe dar continuidade ao seu agendamento.";
    }

    return SAFE_FALLBACK_MESSAGE;
  }

  const instructionMap = {
    ASK_NAME: "Acolha com simpatia e peça o nome completo de forma calorosa, elegante e natural.",
    ASK_REASON: `O paciente informou o nome '${state.name || ""}'. Responda usando o nome dele e peça o motivo principal do contato de forma acolhedora e natural.`,
    ASK_EXAM: `O paciente já informou nome e motivo do contato. Valide brevemente o que ele disse e pergunte, com leveza, se ele já possui exames como radiografia, tomografia ou ressonância.`,
    ASK_PERIOD: `O paciente já informou nome, motivo e respondeu sobre exames. Agora conduza com simpatia para a etapa de agenda e pergunte qual período prefere para atendimento, manhã ou tarde.`,
    FORWARD_SCHEDULING: `O paciente já está pronto para seguir no fluxo. Responda de forma calorosa e organizada, dizendo que o atendimento será encaminhado para continuidade do agendamento.`
  };

  const response = await openai.responses.create({
    model: "gpt-5.4-mini",
    input: [
      {
        role: "system",
        content: SECRETARY_SYSTEM_PROMPT
      },
      {
        role: "system",
        content: `Estado atual da conversa:
Nome: ${state.name || "não informado"}
Motivo: ${state.reason || "não informado"}
Exames: ${state.hasExam || "não informado"}

Instrução da etapa:
${instructionMap[stageInstruction] || "Responda de forma acolhedora e útil."}`
      },
      {
        role: "user",
        content: message
      }
    ]
  });

  return response.output_text?.trim() || SAFE_FALLBACK_MESSAGE;
}

/* ===============================
   ROTAS
================================= */

app.get("/", (req, res) => {
  res.send("Servidor rodando");
});
app.post("/webhook", async (req, res) => {
  try {
    console.log("===== RECEBIDO =====");
    console.log(JSON.stringify(req.body, null, 2));

    console.log("DEBUG:", {
      fromMe: req.body?.fromMe,
      fromApi: req.body?.fromApi,
      message: req.body?.text?.message
    });

const eventType = req.body?.type;
const messageId = req.body?.messageId;
const message = req.body?.text?.message || "";
const rawPhone = req.body?.phone;
const phone = normalizePhone(rawPhone);
const fromMe = req.body?.fromMe;
const fromApi = req.body?.fromApi;
const instanceId = req.body?.instanceId;
const senderName = req.body?.senderName || "";
const conversationKey = getConversationKey(req.body); 

    res.sendStatus(200);

    if (eventType !== "ReceivedCallback") {
      console.log("⚠️ Evento ignorado:", eventType);
      return;
    }

if (!conversationKey || !phone || !instanceId) {
  console.log("⚠️ Dados insuficientes:", {
    rawPhone,
    phone,
    conversationKey,
    instanceId
  });
  return;
}

    const isApiMessage =
      (fromMe === true || fromMe === "true") &&
      (fromApi === true || fromApi === "true" || fromApi === 1);

    const isManualHumanMessage =
      (fromMe === true || fromMe === "true") &&
      !isApiMessage &&
      typeof message === "string" &&
      message.trim() !== "";

    console.log("DEBUG TAKEOVER:", {
      phone,
      fromMe,
      fromApi,
      message,
      isApiMessage,
      isManualHumanMessage,
      inTakeover: isInHumanTakeover(phone)
    });

    if (isApiMessage) {
      console.log("⛔ Ignorado (mensagem da API):", {
        phone,
        fromMe,
        fromApi,
        message
      });
      return;
    }

    if (isManualHumanMessage) {
      activateHumanTakeover(phone);
      console.log("👨‍⚕️ Takeover manual ativado:", phone);
      return;
    }

    if (isInHumanTakeover(phone)) {
      console.log("⛔ IA pausada:", phone);
      return;
    }

    if (alreadyProcessed(messageId)) {
      console.log("⚠️ Mensagem duplicada ignorada:", messageId);
      return;
    }

    if (!message) {
      console.log("⚠️ Mensagem vazia");
      return;
    }

    if (message.trim().toLowerCase() === "menu") {
      clearHumanTakeover(phone);
      console.log("✅ Takeover limpo manualmente para:", phone);
    }

    const classification = await classifyMessage(message);

    if (classification === "DOCTOR" || looksLikeDoctorOrHospital(message)) {
      const handoffMessage = DOCTOR_HANDOFF_MESSAGE;
      await sendWhatsAppMessage(instanceId, phone, handoffMessage);
      await notifyDrRonan(
        instanceId,
        phone,
        senderName,
        message,
        "Contato profissional / sobreaviso / CHN"
      );
      return;
    }

    if (classification === "URGENT" || looksUrgent(message)) {
      const urgentReply = URGENT_HANDOFF_MESSAGE;
      await sendWhatsAppMessage(instanceId, phone, urgentReply);
      await notifyDrRonan(
        instanceId,
        phone,
        senderName,
        message,
        "Urgência clínica"
      );
      return;
    }

saveHistory(conversationKey, "user", message);

const flowResult = await smartFlow(conversationKey, phone, message);

if (
  typeof flowResult === "object" &&
  flowResult?.type === "FINAL_SCHEDULING"
) {
  saveHistory(conversationKey, "assistant", flowResult.patientMessage);

  await sendWhatsAppMessage(instanceId, DR_RONAN_PHONE, flowResult.internalSummary);
  await sendWhatsAppMessage(instanceId, phone, flowResult.patientMessage);
  return;
}

const reply = flowResult;

saveHistory(conversationKey, "assistant", reply);
await sendWhatsAppMessage(instanceId, phone, reply);
  } catch (error) {
    console.error("ERRO NO WEBHOOK:");
    console.error(error.response?.data || error.message || error);
  }
});

/* ===== NOVAS ROTAS DE MONITORAMENTO ===== */

app.post("/delivery", (req, res) => {
  console.log("===== DELIVERY CALLBACK =====");
  console.log(JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

app.post("/message-status", (req, res) => {
  console.log("===== MESSAGE STATUS CALLBACK =====");
  console.log(JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

app.post("/connect", (req, res) => {
  console.log("===== CONNECT CALLBACK =====");
  console.log(JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

app.post("/disconnect", (req, res) => {
  console.log("===== DISCONNECT CALLBACK =====");
  console.log(JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

/* ===============================
   START
================================= */

app.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT);
});
