import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { carregarConfig } from "./config.mjs";
import { construirSnapshot, gerarMudancas } from "./domain.mjs";

const arquivo = process.argv[2];
if (!arquivo) {
    console.error('Uso: node src/replay.mjs "arquivo.jsonl" [config.json]');
    process.exit(1);
}
const config = await carregarConfig(resolve(process.argv[3] ?? "config/products.json"));
const produtos = new Map(config.products.map(p => [p.asin, p]));
const ultimos = new Map();
const tipos = new Map();
let snapshots = 0;
let ignorados = 0;
const linhas = (await readFile(resolve(arquivo), "utf8")).split(/\r?\n/);
for (const linha of linhas) {
    if (!linha.trim()) continue;
    let registro;
    try {
        registro = JSON.parse(linha);
    } catch {
        ignorados++;
        continue;
    }
    if (registro.tipo !== "SNAPSHOT_PRIMEIRA_PAGINA") continue;
    const produto = produtos.get(registro.asin);
    if (!produto) {
        ignorados++;
        continue;
    }
    const snapshot = construirSnapshot({
        ...registro,
        cobertura: registro.snapshotCompleto
            ? "PRIMEIRA_PAGINA_COMPLETA" : "PRIMEIRA_PAGINA_PARCIAL",
        totalVisivel: registro.totalUnico,
        destaquePresente: registro.possuiDestaque
    }, produto, registro.horario);
    const anterior = ultimos.get(produto.asin);
    for (const evento of gerarMudancas(anterior, snapshot)) {
        tipos.set(evento.tipo, (tipos.get(evento.tipo) ?? 0) + 1);
        if (evento.tipo === "TOTAL_OFERTAS_AOD_ALTERADO" ||
            evento.tipo.includes("AMAZON_DIRETA")) {
            console.log(`[${registro.horario}] ${produto.asin}: ${evento.tipo}`, evento.detalhes);
        }
    }
    ultimos.set(produto.asin, snapshot);
    snapshots++;
}
console.log("\nREPLAY OFFLINE — nenhuma requisição à Amazon");
console.table({ snapshots, produtos: ultimos.size, linhasIgnoradas: ignorados });
console.log("Eventos por tipo:");
console.table(Object.fromEntries([...tipos].sort()));
