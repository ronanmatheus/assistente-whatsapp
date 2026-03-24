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

function getState(phone) {
  return conversationState.get(phone) || {
    stage: "START",
    name: null,
    reason: null,
    hasExam: null
  };
}

function updateState(phone, newData) {
  const current = getState(phone);
  const updated = { ...current, ...newData };
  conversationState.set(phone, updated);
}

function getHistory(phone) {
  return conversationMemory.get(phone) || [];
}

function saveHistory(phone, role, content) {
  const history = conversationMemory.get(phone) || [];
  history.push({ role, content });

  if (history.length > 14) {
    history.splice(0, history.length - 14);
  }

  conversationMemory.set(phone, history);
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

/* ===============================
   PROMPTS
================================= */

const SECRETARY_SYSTEM_PROMPT = `
Você é Carla, secretária premium do Dr. Ronan Matheus, cirurgião bucomaxilofacial.

Você atende pacientes pelo WhatsApp com linguagem humana, acolhedora, elegante, calorosa, segura e extremamente profissional.

Seu objetivo não é apenas responder. Seu objetivo é fazer o paciente se sentir bem recebido, compreendido, seguro e conduzido com naturalidade até o próximo passo do atendimento.

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

TOM IDEAL:
- próximo
- gentil
- refinado
- organizado
- seguro
- feminino e acolhedor

COMO RESPONDER:
Toda resposta deve, sempre que possível, ter esta estrutura natural:

1. acolhimento
2. validação ou conexão com o que a pessoa disse
3. direcionamento para o próximo passo

EXEMPLOS DE TOM IDEAL:

Exemplo 1:
"Olá, Adrielly! 😊 Que bom te receber por aqui.

Vai ser um prazer te ajudar.

Sobre o seu caso, conseguimos sim te orientar com calma e entender a melhor forma de condução.

Se você quiser, já posso organizar os próximos passos por aqui 💙"

Exemplo 2:
"Perfeito, João! 😊

Obrigada por me explicar.

Para eu te direcionar da melhor forma, me conta só mais uma coisinha..."

Exemplo 3:
"Entendi, Adrielly.

Isso já ajuda bastante a gente a organizar seu atendimento da forma certa.

Se você quiser, já sigo com você por aqui e deixo tudo mais adiantado."

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

SOBRE CONVÊNIOS:
- quando o paciente perguntar sobre convênio, responda de forma acolhedora e explicativa
- se for convênio odontológico, explique com delicadeza que não atendemos por convênio odontológico
- se houver plano de saúde médico, explique que em alguns casos conseguimos conduzir em ambiente hospitalar, quando indicado
- sempre mantenha tom positivo, nunca burocrático

CONTATO PROFISSIONAL / CHN / SOBREAVISO:
Se a mensagem for de colega médico, hospital, sobreaviso, CHN, parecer, interconsulta, CTI, enfermaria, centro cirúrgico, trauma de face hospitalar ou discussão de caso:
- não siga fluxo de secretária
- responda apenas:
"Recebi sua mensagem. Estou encaminhando isso imediatamente e diretamente ao Dr. Ronan."

URGÊNCIA:
Se houver sinal de urgência relevante:
- interrompa a triagem
- responda com prioridade e segurança
- exemplo:
"Entendi. Pelo que você me relatou, isso merece atenção mais rápida. Vou encaminhar sua mensagem com prioridade ao Dr. Ronan agora."

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

function looksLikeDoctorOrHospital(text) {
  const t = normalizeText(text);

  const terms = [
    "dr ",
    "dra ",
    "doutor",
    "doutora",
    "colega medico",
    "colega medica",
    "medico",
    "cirurgiao",
    "bucomaxilo",
    "sobreaviso",
    "chn",
    "plantao",
    "parecer",
    "interconsulta",
    "avaliacao hospitalar",
    "cti",
    "uti",
    "enfermaria",
    "hospital",
    "pronto socorro",
    "ps",
    "trauma de face",
    "fratura de face",
    "equipe medica"
  ];

  return terms.some(term => t.includes(term));
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

async function smartFlow(phone, message) {
  const state = getState(phone);

  if (state.stage === "START") {
    updateState(phone, { stage: "WAITING_NAME" });
    return await generateStageReply(phone, message, "ASK_NAME");
  }

  if (state.stage === "WAITING_NAME") {
    updateState(phone, {
      stage: "WAITING_REASON",
      name: message
    });
    return await generateStageReply(phone, message, "ASK_REASON");
  }

  if (state.stage === "WAITING_REASON") {
    updateState(phone, {
      stage: "WAITING_EXAM",
      reason: message
    });
    return await generateStageReply(phone, message, "ASK_EXAM");
  }

  if (state.stage === "WAITING_EXAM") {
    updateState(phone, {
      stage: "READY_TO_SCHEDULE",
      hasExam: message
    });
    return await generateStageReply(phone, message, "ASK_PERIOD");
  }

  if (state.stage === "READY_TO_SCHEDULE") {
    return await generateStageReply(phone, message, "FORWARD_SCHEDULING");
  }

  return SAFE_FALLBACK_MESSAGE;
}

async function generateStageReply(phone, message, stageInstruction) {
  const state = getState(phone);

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
    console.log("===== WEBHOOK RECEBIDO =====");
    console.log(JSON.stringify(req.body, null, 2));

    const eventType = req.body?.type;
    const messageId = req.body?.messageId;
    const message = req.body?.text?.message;
    const rawPhone = req.body?.phone;
    const fromMe = req.body?.fromMe;
    const instanceId = req.body?.instanceId;
    const senderName = req.body?.senderName || "";

    res.sendStatus(200);

    if (eventType !== "ReceivedCallback") {
      console.log("⚠️ Evento ignorado:", eventType);
      return;
    }

    if (fromMe === true) {
      console.log("⚠️ Mensagem enviada pela própria instância ignorada");
      return;
    }

    if (alreadyProcessed(messageId)) {
      console.log("⚠️ Mensagem duplicada ignorada:", messageId);
      return;
    }

    const phone = normalizePhone(rawPhone);

    if (!phone || !message || !instanceId) {
      console.log("⚠️ Dados insuficientes:", {
        phone,
        rawPhone,
        message,
        instanceId
      });
      return;
    }

    const classification = await classifyMessage(message);
    const normalized = normalizeText(message);

    if (classification === "DOCTOR" || looksLikeDoctorOrHospital(message)) {
      const handoffMessage = DOCTOR_HANDOFF_MESSAGE;

      await sendWhatsAppMessage(instanceId, phone, handoffMessage);
      await notifyDrRonan(instanceId, phone, senderName, message, "Contato profissional / sobreaviso / CHN");
      return;
    }

    if (classification === "URGENT" || looksUrgent(message)) {
      const urgentReply = URGENT_HANDOFF_MESSAGE;

      await sendWhatsAppMessage(instanceId, phone, urgentReply);
      await notifyDrRonan(instanceId, phone, senderName, message, "Urgência clínica");
      return;
    }

    saveHistory(phone, "user", message);

    let reply = await smartFlow(phone, message);

    saveHistory(phone, "assistant", reply);
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
