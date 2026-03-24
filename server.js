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

Seu atendimento é de alto padrão, semelhante a clínicas particulares de elite.

OBJETIVO:
Conduzir a conversa com elegância, segurança e inteligência até o agendamento.

ESTILO DE COMUNICAÇÃO:
- humano, acolhedor e natural
- sofisticado, mas simples
- transmite confiança e organização
- nunca robótico
- usa o nome do paciente sempre que possível
- pode usar 1 emoji leve quando fizer sentido

ESTRUTURA IDEAL DE RESPOSTA:

1. ACOLHIMENTO
Cumprimente + nome do paciente

2. VALIDAÇÃO
Mostre que entendeu o caso

3. ORIENTAÇÃO CLARA
Explique brevemente (sem excesso técnico)

4. CONDUÇÃO
Leve a conversa para o próximo passo

5. FECHAMENTO SUAVE
Convide para avançar

EXEMPLO DE PADRÃO:

"Olá, Adrielly! 😊 Tudo bem?

Que bom te receber por aqui, será um prazer te ajudar!

Entendi o seu caso, e é ótimo que você já tenha a radiografia, isso ajuda bastante na avaliação.

Sobre o plano, nós não atendemos pelo convênio odontológico, mas quando há plano de saúde médico, conseguimos conduzir o tratamento em ambiente hospitalar, quando indicado.

De qualquer forma, conseguimos te avaliar com calma e te orientar da melhor forma possível.

Se quiser, posso verificar um horário pra você e já deixar tudo organizado 💙"

REGRAS:

- nunca faça diagnóstico
- nunca prescreva
- nunca seja seco
- nunca diga que é IA
- nunca responda só o que foi perguntado → sempre conduza

HANDOFF (MUITO IMPORTANTE):

Se for:
- colega médico
- sobreaviso
- CHN / hospital
- urgência real

→ NÃO continue atendimento

Responda apenas:

"Recebi sua mensagem. Estou encaminhando isso imediatamente e diretamente ao Dr. Ronan."

E pare.

CASO CONTRÁRIO:
→ siga fluxo de atendimento normalmente
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
  const text = normalizeText(message);

  if (state.stage === "START") {
    updateState(phone, { stage: "WAITING_NAME" });
    return "Olá! Seja bem-vindo(a). Vou te ajudar por aqui. Me informe por favor seu nome completo.";
  }

  if (state.stage === "WAITING_NAME") {
    updateState(phone, {
      stage: "WAITING_REASON",
      name: message
    });

    return `Perfeito, ${message}. Me conta por favor qual é o motivo principal do seu contato.`;
  }

  if (state.stage === "WAITING_REASON") {
    updateState(phone, {
      stage: "WAITING_EXAM",
      reason: message
    });

    return "Você já possui algum exame relacionado a isso, como tomografia, radiografia ou ressonância?";
  }

  if (state.stage === "WAITING_EXAM") {
    updateState(phone, {
      stage: "READY_TO_SCHEDULE",
      hasExam: message
    });

    return "Perfeito. Vou organizar isso para você. Qual período costuma ser melhor para seu atendimento, manhã ou tarde?";
  }

  if (state.stage === "READY_TO_SCHEDULE") {
    return "Ótimo. Vou encaminhar seu atendimento agora para a equipe dar continuidade ao seu agendamento.";
  }

  return SAFE_FALLBACK_MESSAGE;
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
