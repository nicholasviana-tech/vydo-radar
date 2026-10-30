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

const saida = { atualizado: new Date().toISOString(), fonte: 'curadoria manual + conferência automática', nichos: [], candidatos: [], log: [] };

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
    const termo = it.busca || it.n;
    if (APP_ID && SECRET && termo) {
      try { for (const c of await candidatos(termo)) saida.candidatos.push({ nicho: n.key, busca: termo, ...c }); }
      catch (e) { say(`Shopee (busca "${termo}"): ${e.message}`); }
    }
    nicho.itens.push(item);
  }
  saida.nichos.push(nicho);
}
if (!APP_ID || !SECRET) say('Sem chaves da Shopee: produtos e candidatos não foram buscados.');
saida.log = log;
fs.writeFileSync('radar/radar.json', JSON.stringify(saida, null, 1));
console.log('radar/radar.json gravado');
