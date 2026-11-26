import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitoringService } from '../server/service.mjs';

async function createTestService() {
  const dir = await mkdtemp(join(tmpdir(), 'vigia-alerts-'));
  const registry = { schemaVersion: 1, products: [] };
  const notices = [];
  const service = new MonitoringService({
    registry,
    save: async () => {},
    projectRoot: dir,
    dataDirectory: dir,
    notifier: async notice => { notices.push(notice); },
  });
  return {
    service,
    registry,
    notices,
    async cleanup() {
      await service.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function makeObservation(store, { available, price = null }) {
  const at = new Date().toISOString();
  if (store === 'amazon') {
    return {
      at,
      available: available ? true : null,
      price: available ? price : null,
      seller: available ? 'Amazon.com.br' : 'Não informado',
      delivery: available ? 'Amazon.com.br' : 'Não informado',
      observation: available ? 'OFERTA_VISIVEL' : 'NAO_OBSERVADO',
      amazonOffers: available ? [{ precoNormalCentavos: Math.round(price * 100), categoria: 'AMAZON_DIRETA', vendedor: 'Amazon.com.br', enviadoPor: 'Amazon.com.br', freteCentavos: 0 }] : [],
    };
  }
  return {
    at,
    available,
    price: available ? price : null,
    seller: available ? 'Loja Teste' : 'Não informado',
    sellerId: available ? '123456' : null,
    delivery: available ? 'Mercado Envios Full' : 'Não informado',
    observation: available ? 'available' : 'unavailable',
  };
}

function productUrl(store, idx) {
  return store === 'amazon'
    ? `https://www.amazon.com.br/dp/B00000000${idx}`
    : `https://produto.mercadolivre.com.br/MLB-10000000${idx}-_JM`;
}

for (const store of ['amazon', 'ml']) {
  test(`[${store}] alert without target notifies once on confirmed availability without repeating`, async () => {
    const { service, notices, cleanup } = await createTestService();
    try {
      await service.add({ store, url: productUrl(store, 1), name: 'Produto Sem Limite', alert: true, target: null });
      const id = service.registry.products[0].id;

      // 1a leitura disponível: ainda não notifica
      service.observe(id, makeObservation(store, { available: true, price: 200 }));
      await service.notificationQueue;
      assert.equal(notices.length, 0);

      // 2a leitura disponível: confirma e notifica 1x
      service.observe(id, makeObservation(store, { available: true, price: 200 }));
      await service.notificationQueue;
      assert.equal(notices.length, 1);
      assert.equal(notices[0].title, 'Vigia · produto disponível');

      // 3a leitura disponível: não repete
      service.observe(id, makeObservation(store, { available: true, price: 190 }));
      await service.notificationQueue;
      assert.equal(notices.length, 1);
    } finally {
      await cleanup();
    }
  });

  test(`[${store}] available above target does not notify, but records availabilityHistory`, async () => {
    const { service, registry, notices, cleanup } = await createTestService();
    try {
      await service.add({ store, url: productUrl(store, 2), name: 'Produto Caro', alert: true, target: 100 });
      const id = service.registry.products[0].id;

      service.observe(id, makeObservation(store, { available: true, price: 150 }));
      service.observe(id, makeObservation(store, { available: true, price: 150 }));
      await service.notificationQueue;

      assert.equal(notices.length, 0);
      assert.ok(registry.availabilityHistory.some(row => row.productId === id && row.type === 'DISPONIBILIDADE_CONFIRMADA'));
    } finally {
      await cleanup();
    }
  });

  test(`[${store}] available within target notifies once and does not repeat on subsequent cycles`, async () => {
    const { service, notices, cleanup } = await createTestService();
    try {
      await service.add({ store, url: productUrl(store, 3), name: 'Produto Barato', alert: true, target: 100 });
      const id = service.registry.products[0].id;

      service.observe(id, makeObservation(store, { available: true, price: 95 }));
      await service.notificationQueue;
      assert.equal(notices.length, 0);

      service.observe(id, makeObservation(store, { available: true, price: 95 }));
      await service.notificationQueue;
      assert.equal(notices.length, 1);
      assert.equal(notices[0].title, 'Vigia · preço limite atingido');

      // Ciclos seguintes continuam dentro do limite: não repete
      service.observe(id, makeObservation(store, { available: true, price: 90 }));
      service.observe(id, makeObservation(store, { available: true, price: 85 }));
      await service.notificationQueue;
      assert.equal(notices.length, 1);
    } finally {
      await cleanup();
    }
  });

  test(`[${store}] price drop on already-available product notifies once when crossing target`, async () => {
    const { service, notices, cleanup } = await createTestService();
    try {
      await service.add({ store, url: productUrl(store, 4), name: 'Produto Queda', alert: true, target: 100 });
      const id = service.registry.products[0].id;
      const rechecks = [];
      service.recheckHandlers.set(store, p => rechecks.push(p.id));

      // Entra disponível acima do limite (2 leituras)
      service.observe(id, makeObservation(store, { available: true, price: 140 }));
      service.observe(id, makeObservation(store, { available: true, price: 140 }));
      await service.notificationQueue;
      assert.equal(notices.length, 0);

      // Preço cai para <= target (1a leitura dispara recheck, não notifica ainda)
      const rechecksBefore = rechecks.length;
      service.observe(id, makeObservation(store, { available: true, price: 100 }));
      await service.notificationQueue;
      assert.equal(notices.length, 0);
      assert.equal(rechecks.length, rechecksBefore + 1);

      // 2a leitura consecutiva <= target: notifica 1x
      service.observe(id, makeObservation(store, { available: true, price: 99.9 }));
      await service.notificationQueue;
      assert.equal(notices.length, 1);
      assert.equal(notices[0].title, 'Vigia · preço limite atingido');

      // 3a leitura <= target: não repete
      service.observe(id, makeObservation(store, { available: true, price: 99.9 }));
      await service.notificationQueue;
      assert.equal(notices.length, 1);
    } finally {
      await cleanup();
    }
  });

  test(`[${store}] editing target resets confirmation state and allows new notification within new target`, async () => {
    const { service, notices, cleanup } = await createTestService();
    try {
      await service.add({ store, url: productUrl(store, 5), name: 'Produto Editado', alert: true, target: 100 });
      const id = service.registry.products[0].id;

      // Disponível a 120 (acima do limite de 100)
      service.observe(id, makeObservation(store, { available: true, price: 120 }));
      service.observe(id, makeObservation(store, { available: true, price: 120 }));
      await service.notificationQueue;
      assert.equal(notices.length, 0);

      // Usuário sobe o limite para 130
      await service.edit(id, { target: 130 });
      assert.equal(service.registry.products[0].availabilityNotification, undefined);
      assert.equal(service.registry.products[0].mlConfirmation, undefined);

      // Após 2 leituras consecutivas dentro do novo limite, notifica
      service.observe(id, makeObservation(store, { available: true, price: 120 }));
      service.observe(id, makeObservation(store, { available: true, price: 120 }));
      await service.notificationQueue;
      assert.equal(notices.length, 1);
      assert.equal(notices[0].title, 'Vigia · preço limite atingido');
    } finally {
      await cleanup();
    }
  });

  test(`[${store}] alert disabled never notifies even when available within target`, async () => {
    const { service, registry, notices, cleanup } = await createTestService();
    try {
      await service.add({ store, url: productUrl(store, 6), name: 'Produto Silencioso', alert: false, target: 100 });
      const id = service.registry.products[0].id;

      service.observe(id, makeObservation(store, { available: true, price: 50 }));
      service.observe(id, makeObservation(store, { available: true, price: 50 }));
      await service.notificationQueue;

      assert.equal(notices.length, 0);
      assert.ok(registry.availabilityHistory.some(row => row.productId === id));
    } finally {
      await cleanup();
    }
  });
}

test('[amazon] backwards compatibility when persisted availabilityNotification.confirmed is a boolean', async () => {
  const { service, notices, cleanup } = await createTestService();
  try {
    await service.add({ store: 'amazon', url: productUrl('amazon', 7), name: 'Legado Amazon', alert: true, target: 100 });
    const product = service.registry.products[0];
    product.availabilityNotification = { confirmed: true, pending: true, count: 2 };

    // Já estava disponível (legado boolean true), mas agora preço entra no limite -> deve notificar ALVO_ATINGIDO após 2 leituras
    service.observe(product.id, makeObservation('amazon', { available: true, price: 90 }));
    service.observe(product.id, makeObservation('amazon', { available: true, price: 90 }));
    await service.notificationQueue;
    assert.equal(notices.length, 1);
    assert.equal(notices[0].title, 'Vigia · preço limite atingido');
  } finally {
    await cleanup();
  }
});
