const express = require('express')
const router = express.Router()
const { readJSON } = require('../utils/fileStore')
const { FILES } = require('../utils/dataInit')
const { authMiddleware } = require('../middleware/auth')

router.get('/armi', authMiddleware, async (req, res) => {
  const armi = await readJSON(FILES.armi)
  res.json(armi)
})

router.get('/equipaggiamento', authMiddleware, async (req, res) => {
  const equipaggiamento = await readJSON(FILES.equipaggiamento)
  res.json(equipaggiamento)
})

module.exports = router
