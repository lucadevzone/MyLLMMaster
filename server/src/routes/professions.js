const express = require('express')
const router = express.Router()
const { readJSON } = require('../utils/fileStore')
const { FILES } = require('../utils/dataInit')
const { authMiddleware } = require('../middleware/auth')

// GET /api/professions
router.get('/', authMiddleware, async (req, res) => {
  const professions = await readJSON(FILES.professions)
  res.json(professions)
})

module.exports = router
