import { basename, resolve } from 'node:path'
import { db } from '../server/db'
import { seedRichTeams } from './fixture-data'

/**
 * Rebuilds the realistic team demo only for the separate demo accounts in the
 * main app database. Other accounts and teams are never touched.
 */
const target = resolve(process.cwd(), process.env.DUIT_DB_PATH ?? './server/data/todo.db')
if (basename(target) !== 'todo.db') {
  throw new Error('This script only seeds the main app DB demo accounts.')
}

const PASSWORD = 'demo12345'

seedRichTeams({
  db,
  prefix: 'demo',
  password: PASSWORD,
  lead: { email: 'ml-demo@example.com', name: 'ML Demo' },
  mate: { email: 'ml-demo-mate@example.com', name: 'Demo Mate' },
  priya: { email: 'ml-demo-priya@example.com', name: 'Priya Shah' },
  legacyTeamIds: ['ml-demo-launch-crew'],
})

console.log('Rich demo teams seeded in the main app DB (demo accounts only).')
console.log(`  ml-demo@example.com / ${PASSWORD} (host, 3 teams + 1 invitation)`)
console.log(`  ml-demo-mate@example.com / ${PASSWORD} (host/member)`)
console.log(`  ml-demo-priya@example.com / ${PASSWORD} (host/member)`)
console.log('  Teams: Launch Crew, Product Release, Ops Hub, Design Guild (invitation)')
