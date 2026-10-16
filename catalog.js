const MATERIALS = [
  { id: 'entulho', name: 'Entulho de obras', pts: 6, unit: 'saco', hint: 'Conte em sacos ou baldes. O funcionário confirma a quantidade no ponto.' },
  { id: 'papelao', name: 'Papelão / Papel', pts: 1 },
  { id: 'plastico', name: 'Plástico', pts: 5 },
  { id: 'vidro', name: 'Vidro', pts: 4 },
  { id: 'metal', name: 'Metal', pts: 8 },
  { id: 'eletronico', name: 'Eletrônico (e-lixo)', pts: 10 },
  { id: 'oleo', name: 'Óleo de cozinha usado', pts: 5 },
  { id: 'pilha', name: 'Pilhas / Baterias', pts: 10 }
];

const SMALL_VOLUMES = 'Pequenos volumes (móveis, entulho, recicláveis)';
const HORARIO = { texto: 'Seg a sáb, 8h às 16h', dias: [1, 2, 3, 4, 5, 6], abre: '08:00', fecha: '16:00', estimado: true };

const POINTS = [
  { id: 'p6', name: 'Ponto — Capelinha', bairro: 'Capelinha', endereco: 'Rua Espanha, nº 400', aceita: SMALL_VOLUMES, horario: HORARIO, real: true, geocoded: false, lat: -19.9550, lng: -44.2200 },
  { id: 'p7', name: 'Ponto — Vila Cristina (Barra Longa)', bairro: 'Vila Cristina', endereco: 'Rua Barra Longa', aceita: SMALL_VOLUMES, horario: HORARIO, real: true, geocoded: false, lat: -19.9750, lng: -44.1850 },
  { id: 'p8', name: 'Ponto — Jardim Pérola', bairro: 'Jardim Pérola', endereco: 'Av. Luiza de Jesus Barbosa', aceita: SMALL_VOLUMES, horario: HORARIO, real: true, geocoded: false, lat: -19.9850, lng: -44.1700 },
  { id: 'p9', name: 'Ponto — Vila Cristina (Rua Dez)', bairro: 'Vila Cristina', endereco: 'Rua Dez, nº 345', aceita: SMALL_VOLUMES, horario: HORARIO, real: true, geocoded: false, lat: -19.9720, lng: -44.1900 },
  { id: 'p10', name: 'Ponto — Granja Verde', bairro: 'Granja Verde', endereco: 'Rua Um', aceita: SMALL_VOLUMES, horario: HORARIO, real: true, geocoded: false, lat: -19.9300, lng: -44.2100 },
  { id: 'p11', name: 'Ponto — Av. Juiz Marco Túlio Isaac', bairro: 'Betim', endereco: 'Av. Juiz Marco Túlio Isaac', aceita: SMALL_VOLUMES, horario: HORARIO, real: true, geocoded: false, lat: -19.9600, lng: -44.2050 },
  { id: 'p12', name: 'Ponto — Teresópolis', bairro: 'Teresópolis', endereco: 'Rua Jequié, 178', aceita: SMALL_VOLUMES, horario: HORARIO, real: true, geocoded: false, lat: -19.9450, lng: -44.1850 }
];

const REWARDS = [
  { id: 'r7', name: 'Bolo de pote — Delícias da Taty', cost: 70 },
  { id: 'r2', name: 'Vale-refeição (restaurantes parceiros)', cost: 150 },
  { id: 'r3', name: 'Passagem de ônibus municipal', cost: 100 },
  { id: 'r4', name: 'Desconto no IPTU', cost: 300 },
  { id: 'r6', name: 'Vale-compras: R$ 50 de desconto a cada R$ 200 em compras', cost: 300 },
  { id: 'r8', name: 'Muda de hortaliça', cost: 30 }
];

const catalogJson = JSON.stringify({ materials: MATERIALS, points: POINTS, rewards: REWARDS })
  .replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

module.exports = { MATERIALS, POINTS, REWARDS, catalogJson };
