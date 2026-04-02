const path = require('path')
const { readJSON } = require('../utils/fileStore')
const { DATA_DIR, FILES } = require('../utils/dataInit')

async function getModuleById(moduleId) {
  return readJSON(path.join(DATA_DIR, 'modules', `${moduleId}.json`))
}

async function getAllUsers() {
  return readJSON(FILES.users)
}

function countActiveInvitedPlayers(invitedPlayers = [], users = []) {
  return invitedPlayers.filter(email => {
    const user = users.find(u => u.email === email)
    return user?.role === 'player' && user.accountState === 'attivo'
  }).length
}

async function validateInvitedPlayersForModule(moduleId, invitedPlayers = []) {
  const mod = await getModuleById(moduleId)
  const invitedCount = invitedPlayers.length

  if (invitedCount < mod.minPlayers || invitedCount > mod.maxPlayers) {
    const err = new Error(
      `Il modulo richiede da ${mod.minPlayers} a ${mod.maxPlayers} giocatori invitati`
    )
    err.status = 400
    throw err
  }

  return mod
}

async function tableShouldBeDisabled(table) {
  const [mod, users] = await Promise.all([
    getModuleById(table.moduleId),
    getAllUsers()
  ])
  const activePlayers = countActiveInvitedPlayers(table.invitedPlayers, users)
  return activePlayers < mod.minPlayers
}

async function reconcileTableState(table) {
  const shouldDisable = await tableShouldBeDisabled(table)
  if (shouldDisable) return 'disabled'
  if (table.state === 'disabled') return 'active'
  return table.state
}

module.exports = {
  getModuleById,
  getAllUsers,
  countActiveInvitedPlayers,
  validateInvitedPlayersForModule,
  tableShouldBeDisabled,
  reconcileTableState
}
