// Robô do Radar da Vydo. Roda todo dia no GitHub Actions, sem custo.
// Lê radar/curadoria.json (vídeos escolhidos à mão), confere se cada vídeo ainda existe,
// puxa dados de produto da Shopee quando houver chave e grava radar/radar.json.
// Não usa nenhuma biblioteca de fora. Nada aqui inventa número: sem chave, o campo fica vazio.
import fs from 'node:fs';
import crypto from 'node:crypto';

const APP_ID = process.env.SHOPEE_APP_ID || '';
const SECRET = process.env.SHOPEE_SECRET || '';
const YT_KEY = process.env.YOUTUBE_API_KEY || '';
const SHOPEE_URL = 'https://open-api.affiliate.shopee.com.br/graphql';
const log = [];
const say = (m) => { log.push(m); console.log(m); };

const cur = JSON.parse(fs.readFileSync('radar/curadoria.json', 'utf8'));

async function getJson(url) {
  const r = await fetch(url, { headers: { 'user-agent': 'vydo-radar/1.0' } });
  if (!r.ok) throw new Error(r.status + ' ' + url);
  return r.json();
}

// TikTok: oEmbed público. 200 = o vídeo ainda existe. Traz título, autor e miniatura.
async function checkTikTok(v) {
  try {
    const j = await getJson('https://www.tiktok.com/oembed?url=' + encodeURIComponent(v.url));
    return { disponivel: true, titulo: j.title || '', autor: j.author_name || v.who, miniatura: j.thumbnail_url || '' };
  } catch (e) {
    // Só marca como apagado quando o TikTok diz que não existe (400/404). Qualquer outro erro, como bloqueio, fica como "não sei".
    const apagado = /^(400|404) /.test(String(e.message));
    return { disponivel: apagado ? false : null, erro: String(e.message).slice(0, 80) };
  }
}

// YouTube: precisa de chave. Traz visualizações reais.
async function checkYouTube(v) {
  const m = /(?:shorts\/|watch\?v=|youtu\.be\/)([\w-]{6,})/.exec(v.url);
  if (!m || !YT_KEY) return { disponivel: null };
  try {
    const j = await getJson('https://www.googleapis.com/youtube/v3/videos?part=statistics,snippet&id=' + m[1] + '&key=' + YT_KEY);
    const it = (j.items || [])[0]; if (!it) return { disponivel: false };
    return { disponivel: true, titulo: it.snippet.title, autor: it.snippet.channelTitle, miniatura: it.snippet.thumbnails?.high?.url || '', visualizacoes: Number(it.statistics.viewCount || 0) };
  } catch (e) { return { disponivel: null, erro: String(e.message).slice(0, 80) }; }
}

// Shopee: API oficial de afiliados (GraphQL), assinada com SHA-256.
// ATENÇÃO: nomes de campos e tipos vieram de bibliotecas de terceiros. Conferir na doc oficial
// (affiliate.shopee.com.br/open_api/home) quando as chaves chegarem. Erros ficam no log, sem derrubar o robô.
async function shopee(query) {
  const payload = JSON.stringify({ query });
  const ts = Math.floor(Date.now() / 1000);
  const sig = crypto.createHash('sha256').update(APP_ID + ts + payload + SECRET).digest('hex');
  const r = await fetch(SHOPEE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `SHA256 Credential=${APP_ID}, Timestamp=${ts}, Signature=${sig}` },
    body: payload,
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 200));
  return j.data;
}
const FIELDS = 'itemId productName imageUrl priceMin priceMax commissionRate sales ratingStar shopName offerLink productLink';
const esc = (s) => String(s).replace(/[\\"]/g, ' ').slice(0, 80);

async function produtoExato(itemId) {
  const d = await shopee(`{ productOfferV2(itemId: ${Number(itemId)}, limit: 1) { nodes { ${FIELDS} } } }`);
  return d?.productOfferV2?.nodes?.[0] || null;
}
async function candidatos(busca) {
  const d = await shopee(`{ productOfferV2(keyword: "${esc(busca)}", sortType: 2, limit: 5) { nodes { ${FIELDS} } } }`);
  return d?.productOfferV2?.nodes || [];
}


// Termos curtos e genéricos por nicho, usados só para achar os mais vendidos de verdade.
// (Nome de produto de vídeo é específico demais e traz anúncio com poucas vendas.)
const BUSCA_NICHO = {
  beleza: ['protetor solar', 'skincare', 'base maquiagem', 'perfume', 'máscara de cílios', 'hidratante facial', 'batom'],
  casa: ['organizador', 'kit de potes', 'panela', 'cortina', 'luminária', 'tapete', 'pote hermético'],
  moda: ['vestido', 'tênis feminino', 'bolsa feminina', 'conjunto feminino', 'relógio', 'camiseta'],
  pet: ['ração', 'caminha pet', 'brinquedo para cachorro', 'arranhador gato', 'coleira', 'tapete higiênico'],
  carros: ['capa banco carro', 'suporte celular carro', 'aspirador automotivo', 'capa de moto', 'organizador porta-malas', 'led carro'],
  comida: ['air fryer', 'forma de silicone', 'faca cozinha', 'garrafa térmica', 'marmita', 'liquidificador'],
  bebe: ['fralda', 'mamadeira', 'carrinho de bebê', 'brinquedo bebê', 'babador', 'mordedor'],
  brinquedos: ['lego', 'boneca', 'carrinho de brinquedo', 'quebra-cabeça', 'massinha', 'pelúcia'],
  eletronicos: ['fone bluetooth', 'carregador', 'smartwatch', 'caixa de som', 'cabo usb', 'mouse'],
  fitness: ['creatina', 'whey protein', 'garrafa academia', 'faixa elástica', 'luva de treino', 'corda de pular'],
  ferramentas: ['furadeira', 'parafusadeira', 'kit ferramentas', 'chave de fenda', 'trena', 'fita veda rosca'],
};
// Busca própria para itens cujo nome de vídeo não acha nada na Shopee.
const BUSCA_ITEM = {
  'Kit de skincare com oferta por tempo limitado': 'kit skincare',
  'Spray matificante para pele oleosa': 'spray fixador maquiagem',
  'Gaveteiro portátil com rodinhas': 'gaveteiro com rodinhas',
  'Porta que deixa o gato passar e luva tira-pelos': 'luva tira pelos',
  'Painel de LED solar com olhos para o vidro traseiro': 'painel led carro',
  'Mamadeira usada como chuveirinho': 'mamadeira',
  'Calendário de Natal com 28 brinquedos': 'calendário advento brinquedos',
  'Brinquedos baratinhos da Shopee': 'brinquedo infantil',
  'Whey protein em oferta': 'whey protein',
  'Creatina para ter em casa': 'creatina',
  'Kit que transforma parafusadeira em semiautomática': 'adaptador parafusadeira',
};
const MIN_VENDAS = 100; // abaixo disso não é "mais vendido"
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));
async function maisVendidos(termo) {
  const d = await shopee(`{ productOfferV2(keyword: "${esc(termo)}", sortType: 2, limit: 20) { nodes { ${FIELDS} } } }`);
  return d?.productOfferV2?.nodes || [];
}

const saida = { atualizado: new Date().toISOString(), fonte: 'curadoria manual + conferência automática', nichos: [], candidatos: [], maisVendidos: {}, log: [] };

for (const n of cur.nichos) {
  const nicho = { key: n.key, label: n.label, itens: [] };
  for (const it of n.itens) {
    const item = { ...it, videos: [] };
    for (const v of it.videos) {
      const st = v.src === 'TikTok' ? await checkTikTok(v) : v.src === 'YouTube' ? await checkYouTube(v) : { disponivel: null };
      item.videos.push({ ...v, ...st });
      if (st.disponivel === false) say(`Vídeo indisponível: ${v.url}`);
    }
    if (APP_ID && SECRET && it.shopee?.itemId) {
      try { item.produtoShopee = await produtoExato(it.shopee.itemId); }
      catch (e) { say(`Shopee (produto ${it.shopee.itemId}): ${e.message}`); }
    }
    // Se o item não tem termo de busca próprio, usa o nome do produto como busca.
    const termo = it.busca || BUSCA_ITEM[it.n] || it.n;
    if (APP_ID && SECRET && termo) {
      try { for (const c of await candidatos(termo)) saida.candidatos.push({ nicho: n.key, busca: termo, ...c }); }
      catch (e) { say(`Shopee (busca "${termo}"): ${e.message}`); }
    }
    nicho.itens.push(item);
  }
  saida.nichos.push(nicho);
}

// Mais vendidos por nicho: junta os resultados dos termos genéricos, tira repetidos e ordena por vendas.
if (APP_ID && SECRET) {
  for (const [nk, termos] of Object.entries(BUSCA_NICHO)) {
    const vistos = new Map();
    for (const t of termos) {
      try { for (const c of await maisVendidos(t)) if (!vistos.has(c.itemId)) vistos.set(c.itemId, c); }
      catch (e) { say(`Shopee (mais vendidos "${t}"): ${e.message}`); }
      await pausa(300);
    }
    saida.maisVendidos[nk] = [...vistos.values()]
      .filter((c) => Number(c.sales) >= MIN_VENDAS)
      .sort((a, b) => Number(b.sales) - Number(a.sales))
      .slice(0, 10);
    say(`Mais vendidos ${nk}: ${saida.maisVendidos[nk].length} (de ${vistos.size} achados)`);
  }
}
if (!APP_ID || !SECRET) say('Sem chaves da Shopee: produtos e candidatos não foram buscados.');
saida.log = log;
fs.writeFileSync('radar/radar.json', JSON.stringify(saida, null, 1));
console.log('radar/radar.json gravado');
