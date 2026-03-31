const fs = require('fs').promises
const path = require('path')
const bcrypt = require('bcrypt')

const DATA_DIR = process.env.DATA_DIR_OVERRIDE || path.join(__dirname, '../../../data')

const DIRS = [
  DATA_DIR,
  path.join(DATA_DIR, 'tables'),
  path.join(DATA_DIR, 'modules'),
]

const FILES = {
  users: path.join(DATA_DIR, 'users.json'),
  professions: path.join(DATA_DIR, 'professions.json'),
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

  // Init professions.json if not exists
  try {
    await fs.access(FILES.professions)
  } catch {
    await fs.writeFile(FILES.professions, JSON.stringify(DEFAULT_PROFESSIONS, null, 2))
    console.log('Creato data/professions.json')
  }
}

const DEFAULT_PROFESSIONS = [
  {
    nome: 'Antiquario',
    abilita: ['Valutare', 'Arte/Artigianato (qualsiasi)', 'Storia', 'Biblioteca', 'Altra Lingua', 'Interpersonale (a scelta)', 'Individuare Nascosti', 'Abilità a scelta']
  },
  {
    nome: 'Scrittore',
    abilita: ['Arte (Letteratura)', 'Storia', 'Biblioteca', 'Mondo Naturale o Occulto', 'Altra Lingua', 'Lingua Madre', 'Psicologia', 'Abilità a scelta']
  },
  {
    nome: 'Dilettante',
    abilita: ['Arte/Artigianato (qualsiasi)', 'Armi da Fuoco', 'Altra Lingua', 'Equitazione', 'Interpersonale (a scelta)', 'Abilità a scelta', 'Abilità a scelta', 'Abilità a scelta']
  },
  {
    nome: 'Medico',
    abilita: ['Primo Soccorso', 'Altra Lingua (Latino)', 'Medicina', 'Psicologia', 'Scienze (Biologia)', 'Scienze (Farmacologia)', 'Specialità a scelta', 'Specialità a scelta']
  },
  {
    nome: 'Giornalista',
    abilita: ['Arte/Artigianato (Fotografia)', 'Storia', 'Biblioteca', 'Lingua Madre', 'Interpersonale (a scelta)', 'Psicologia', 'Abilità a scelta', 'Abilità a scelta']
  },
  {
    nome: 'Detective della Polizia',
    abilita: ['Arte/Artigianato (Recitazione) o Travestimento', 'Armi da Fuoco', 'Legge', 'Ascoltare', 'Interpersonale (a scelta)', 'Psicologia', 'Individuare Nascosti', 'Abilità a scelta']
  },
  {
    nome: 'Investigatore Privato',
    abilita: ['Arte/Artigianato (Fotografia)', 'Travestimento', 'Legge', 'Biblioteca', 'Interpersonale (a scelta)', 'Psicologia', 'Individuare Nascosti', 'Abilità a scelta']
  },
  {
    nome: 'Professore',
    abilita: ['Biblioteca', 'Altra Lingua', 'Lingua Madre', 'Psicologia', 'Specialità accademica', 'Specialità accademica', 'Specialità accademica', 'Specialità accademica']
  }
]

module.exports = { ensureDataDirs, DATA_DIR, FILES }
