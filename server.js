import express from 'express'

const app = express()
app.use(express.json())

app.post('/webhook', async (req, res) => {
  console.log('Mensagem recebida:')
  console.log(req.body)

  res.sendStatus(200)
})

app.get('/', (req, res) => {
  res.send('Servidor rodando')
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`)
})
