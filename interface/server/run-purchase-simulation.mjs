import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPurchaseSimulation } from './purchase-simulation.mjs';

const scenarioId = process.argv[2];
const amazonFlow = process.argv[3] || 'random';
const projectRoot = resolve(process.env.MONITOR_PROJECT_ROOT || fileURLToPath(new URL('../..', import.meta.url)));
const outputRoot = process.env.RESEARCH_OUTPUT_ROOT || '';

if (!scenarioId) {
  console.error('Uso: node interface/server/run-purchase-simulation.mjs <scenarioId> [A|B|random]');
  process.exit(1);
}

const reportId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${scenarioId}`;
const result = await runPurchaseSimulation({
  scenarioId,
  projectRoot,
  amazonFlow,
  onLog: chunk => process.stdout.write(chunk),
});

if (outputRoot) {
  const reportsDir = join(outputRoot, 'reports');
  await mkdir(reportsDir, { recursive: true });
  await writeFile(
    join(reportsDir, `${reportId}.json`),
    JSON.stringify({ id: reportId, ...result }, null, 2),
    'utf8',
  );
}

if (result.status !== 'passed') {
  console.error(result.error || 'Simulação de compra falhou.');
  process.exit(1);
}
