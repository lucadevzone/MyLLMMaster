// Call of Cthulhu - logica generazione personaggio

const STAT_POOL = [40, 50, 50, 50, 60, 60, 60, 70, 80]
const STATS = ['FOR', 'COS', 'DES', 'TAG', 'INT', 'POT', 'APP', 'EDU']

export function rollCharacteristics() {
  const pool = [...STAT_POOL].sort(() => Math.random() - 0.5)
  const chars = {}
  STATS.forEach((s, i) => { chars[s] = pool[i] })
  const fortuna = pool[8]
  return { characteristics: chars, fortuna }
}

export function calcDerivedAttributes(chars) {
  const { FOR, COS, DES, TAG, POT } = chars

  const hpMax = Math.floor((COS + TAG) / 10)
  const mpMax = Math.floor(POT / 5)

  const ft = FOR + TAG
  let bonusDanno, build
  if (ft <= 64)       { bonusDanno = '-2';   build = -2 }
  else if (ft <= 84)  { bonusDanno = '-1';   build = -1 }
  else if (ft <= 124) { bonusDanno = '0';    build = 0  }
  else if (ft <= 164) { bonusDanno = '+1d4'; build = 1  }
  else                { bonusDanno = '+1d6'; build = 2  }

  let movimento
  if (FOR < TAG && DES < TAG)       movimento = 7
  else if (FOR >= TAG && DES >= TAG) movimento = 9
  else                               movimento = 8

  return {
    hp:     { max: hpMax, current: hpMax },
    mp:     { max: mpMax, current: mpMax },
    sanita: { max: 99, current: POT, startingValue: POT },
    bonusDanno,
    build,
    movimento
  }
}

export function buildAbilita(chars, profession) {
  const comuni = {
    schivare:   Math.floor(chars.DES / 2),
    rissa:      25,
    ascoltare:  20,
    charme:     15,
    intimidire: 15,
    persuadere: 10,
    raggirare:  5,
    osservare:  25,
    psicologia: 10,
    credito:    10
  }

  const specialistiche = (profession?.abilita || []).map(nome => ({
    nome,
    valore: 40
  }))

  return { comuni, specialistiche }
}
