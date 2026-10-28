const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

let database;
let ready;
const databasePath = path.join(__dirname, 'pulseplay.sqlite');

const schema = `
  CREATE TABLE IF NOT EXISTS questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    description TEXT NOT NULL,
    alternatives TEXT NOT NULL,
    correct_alternative INTEGER NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('multiple_choice', 'true_false')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

const seedQuestions = [
  ['Qual planeta é conhecido como Planeta Vermelho?', ['Vênus', 'Marte', 'Júpiter', 'Mercúrio'], 1, 'multiple_choice'],
  ['Qual é o maior oceano da Terra?', ['Atlântico', 'Índico', 'Pacífico', 'Ártico'], 2, 'multiple_choice'],
  ['Em que ano a internet nasceu?', ['1969', '1984', '1995', '2001'], 0, 'multiple_choice'],
  ['A água ferve a 100 graus Celsius ao nível do mar.', ['Verdadeiro', 'Falso'], 0, 'true_false']
];

function persist() {
  fs.writeFileSync(databasePath, Buffer.from(database.export()));
}

function rowsToQuestions(result) {
  return result.values.map(row => ({
    id: row[0], description: row[1], alternatives: JSON.parse(row[2]), correctAlternative: row[3], type: row[4]
  }));
}

async function initialize() {
  const SQL = await initSqlJs({ locateFile: file => path.join(__dirname, 'node_modules', 'sql.js', 'dist', file) });
  database = fs.existsSync(databasePath) ? new SQL.Database(fs.readFileSync(databasePath)) : new SQL.Database();
  database.run(schema);
  const count = database.exec('SELECT COUNT(*) FROM questions')[0].values[0][0];
  if (count === 0) {
    for (const question of seedQuestions) database.run('INSERT INTO questions (description, alternatives, correct_alternative, type) VALUES (?, ?, ?, ?)', [question[0], JSON.stringify(question[1]), question[2], question[3]]);
    persist();
  }
}

ready = initialize();

async function listQuestions() {
  await ready;
  return rowsToQuestions(database.exec('SELECT id, description, alternatives, correct_alternative, type FROM questions ORDER BY id DESC')[0]);
}

async function createQuestion({ description, alternatives, correctAlternative, type }) {
  await ready;
  database.run('INSERT INTO questions (description, alternatives, correct_alternative, type) VALUES (?, ?, ?, ?)', [description, JSON.stringify(alternatives), correctAlternative, type]);
  persist();
  return (await listQuestions())[0];
}

module.exports = { listQuestions, createQuestion };