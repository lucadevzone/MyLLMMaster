const fs = require('fs').promises
const path = require('path')

async function readJSON(filePath) {
  const data = await fs.readFile(filePath, 'utf-8')
  return JSON.parse(data)
}

async function writeJSON(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2))
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true })
}

module.exports = { readJSON, writeJSON, fileExists, ensureDir }
