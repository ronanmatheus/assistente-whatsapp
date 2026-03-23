const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Servidor online 🚀");
});

app.post("/zapi/webhook", async (req, res) => {
  try {
    const data = req.body;

    const phone = data.phone;
    const text = data.text?.message;

    console.log("Mensagem recebida:", text);

    if (!phone || !text) {
      return res.status(200).send("ok");
    }

    // resposta simples (depois vamos colocar IA aqui)
    const resposta = `Recebi sua mensagem: ${text}`;

    await axios.post(
      `https://api.z-api.io/instances/${process.env.ZAPI_INSTANCE_ID}/token/${process.env.ZAPI_INSTANCE_TOKEN}/send-text`,
      {
        phone: phone,
        message: resposta,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "Client-Token": process.env.ZAPI_CLIENT_TOKEN,
        },
      }
    );

    res.status(200).send("ok");
  } catch (error) {
    console.log(error.message);
    res.status(500).send("erro");
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Servidor rodando");
});
