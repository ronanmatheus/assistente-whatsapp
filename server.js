import express from "express";
import axios from "axios";

const app = express();
app.use(express.json());

const ZAPI_URL = "SUA_URL_ZAPI";
const ZAPI_TOKEN = "SEU_TOKEN";

app.post("/webhook", async (req, res) => {
  console.log("===== WEBHOOK RECEBIDO =====");

  const mensagem = req.body.text?.message;
  const telefone = req.body.phone;

  if (!mensagem) {
    return res.sendStatus(200);
  }

  try {
    // 🔥 IA responde
    const respostaIA = `Recebi sua mensagem: "${mensagem}". Em breve nossa equipe irá te atender.`;

    // 🔥 envia resposta no WhatsApp
    await axios.post(
      `${ZAPI_URL}`,
      {
        phone: telefone,
        message: respostaIA
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Client-Token": ZAPI_TOKEN
        }
      }
    );

  } catch (erro) {
    console.error("Erro ao responder:", erro.message);
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT);
});
