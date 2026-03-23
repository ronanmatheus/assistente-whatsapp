import express from "express";

const app = express();
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Servidor rodando");
});

app.post("/webhook", (req, res) => {
  console.log("Mensagem recebida:");
  console.log(JSON.stringify(req.body, null, 2));
  res.sendStatus(200);
});

app.listen(8080, () => {
  console.log("Servidor rodando na porta 8080");
});
