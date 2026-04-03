const fs = require('fs').promises
const path = require('path')
const bcrypt = require('bcrypt')

const DATA_DIR = process.env.DATA_DIR_OVERRIDE || path.join(__dirname, '../../../data')

const RULES_DIR = path.join(__dirname, '../../../../rules')

const DIRS = [
  DATA_DIR,
  path.join(DATA_DIR, 'tables'),
  path.join(DATA_DIR, 'modules'),
]

const FILES = {
  users: path.join(DATA_DIR, 'users.json'),
  professions: path.join(RULES_DIR, 'professions.json'),
  armi: path.join(RULES_DIR, 'armi.json'),
  equipaggiamento: path.join(RULES_DIR, 'equipaggiamento.json'),
}

async function ensureDataDirs() {
  for (const dir of DIRS) {
    await fs.mkdir(dir, { recursive: true })
  }

  // Init users.json if not exists — crea admin di default
  try {
    await fs.access(FILES.users)
  } catch {
    const hash = await bcrypt.hash('admin123', 10)
    const admin = [{
      email: 'admin@test.com',
      name: 'Admin',
      role: 'admin',
      password: hash,
      accountState: 'attivo',
      createdAt: new Date().toISOString()
    }]
    await fs.writeFile(FILES.users, JSON.stringify(admin, null, 2))
    console.log('Creato data/users.json con admin di default')
  }

}

module.exports = { ensureDataDirs, DATA_DIR, FILES }
