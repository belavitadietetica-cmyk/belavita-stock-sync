// ═══════════════════════════════════════════════════════════════════════════
// BELAVITA STOCK SYNC
// Sincroniza el stock de Belavita Ops (Supabase, schema `ops`) hacia Tienda Nube.
//
// ARQUITECTURA (decidida): el POS NUNCA llama a Tienda Nube directo. El POS solo
// descuenta stock en Supabase (rápido, sin depender de la API de TN). Este proceso
// corre SEPARADO en Railway, cada 15 minutos, lee el stock real de Supabase, calcula
// cuánto mostrar en cada variante de la tienda, y lo escribe. Si una corrida falla,
// la siguiente lo autocorrige (es idempotente: siempre escribe el valor absoluto).
//
// SEGURIDAD: arranca en modo REPORTE (DRY_RUN=true). En ese modo lee todo y calcula,
// pero NO escribe nada en Tienda Nube. Para activar la escritura real, poner la
// variable de entorno DRY_RUN=false en Railway.
// ═══════════════════════════════════════════════════════════════════════════

const http = require('http');
const { createClient } = require('@supabase/supabase-js');

// ─── Configuración (todo por variables de entorno en Railway) ────────────────
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;      // service_role (NO la anon)
const TN_TOKEN      = process.env.TN_TOKEN;                  // token de Tienda Nube
const TN_STORE_ID   = process.env.TN_STORE_ID || '5833059';
const TN_USER_AGENT = process.env.TN_USER_AGENT || 'BelavitaOps (belavitadietetica@gmail.com)';
const DRY_RUN       = (process.env.DRY_RUN || 'true').toLowerCase() !== 'false'; // default: REPORTE
const INTERVALO_MIN = parseInt(process.env.INTERVALO_MIN || '15', 10);
const PORT          = process.env.PORT || 3000;

// Sucursales físicas que suman stock. La tienda online (bvt) no tiene stock propio.
const SUCURSALES_FISICAS = ['bv1', 'bv2', 'bv3'];
// Margen de seguridad que se le resta al stock de granel (en kg), para no vender lo último.
const MARGEN_GRANEL_KG = 1;
// Margen de venta que Tienda Nube debe reflejar sobre el precio de Ops.
const MARGEN_TIENDA = 1.10;
// Tolerancia para no marcar como "desvío" simples diferencias de redondeo comercial
// (redondear el precio final a la centena/cincuentena más cercana es una práctica normal).
const TOLERANCIA_PESOS = 50;
const TOLERANCIA_PCT = 3; // %

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('✗ Falta SUPABASE_URL o SUPABASE_SERVICE_KEY. Cortando.');
  process.exit(1);
}
if (!TN_TOKEN) {
  console.error('✗ Falta TN_TOKEN. Cortando.');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const TN_BASE = `https://api.tiendanube.com/v1/${TN_STORE_ID}`;

// Guardamos el último reporte en memoria para poder verlo por HTTP (GET /reporte).
let ultimoReporte = { estado: 'todavía no corrió', ts: null };
let ultimaAuditoriaPrecios = { estado: 'todavía no corrió', ts: null };
let corriendo = false;
let auditando = false;

// ═══════════════════════════════════════════════════════════════════════════
// 1) LECTURA DE SUPABASE
// ═══════════════════════════════════════════════════════════════════════════

// Trae TODAS las filas de una tabla del schema ops, paginando de a 1000.
// (Supabase corta en 1000 por consulta; sin esto veríamos solo una parte.)
async function traerTodo(tabla, columnas) {
  const PAGINA = 1000;
  let desde = 0;
  let todo = [];
  while (true) {
    const { data, error } = await sb.schema('ops')
      .from(tabla)
      .select(columnas)
      .range(desde, desde + PAGINA - 1);
    if (error) throw new Error(`Leyendo ops.${tabla}: ${error.message}`);
    todo = todo.concat(data);
    if (!data || data.length < PAGINA) break; // última tanda
    desde += PAGINA;
  }
  return todo;
}

async function cargarDatosOps() {
  // IMPORTANTE: Supabase (PostgREST) devuelve máximo 1000 filas por consulta.
  // Nuestras tablas son más grandes (productos y stock_sucursal pasan las 1000),
  // así que hay que paginar con .range() y traer TODO en tandas, o si no el sync
  // ve solo una parte del catálogo y del stock.
  const productos = await traerTodo('productos', 'id, codigo, nombre, tipo_venta, kg_por_unidad, producto_bulk_id, stock_kg_actual, precio_venta, activo, se_vende');
  const stockSuc  = await traerTodo('stock_sucursal', 'producto_id, sucursal_id, cantidad');
  const combos    = await traerTodo('combo_componentes', 'combo_codigo, componente_codigo, cantidad');

  // ── Índices en memoria para no consultar de a uno ──
  const porCodigo = new Map();   // codigo(text) -> producto
  const porId     = new Map();   // id(number)   -> producto
  for (const p of productos) {
    if (p.codigo != null) porCodigo.set(String(p.codigo).trim(), p);
    porId.set(Number(p.id), p);
  }

  // Suma de stock físico (bv1+bv2+bv3) por producto_id.
  const stockFisicoPorId = new Map();
  for (const row of stockSuc) {
    const suc = String(row.sucursal_id || '').toLowerCase();
    if (!SUCURSALES_FISICAS.includes(suc)) continue; // ignora bvt u otros
    const pid = Number(row.producto_id);
    const acum = stockFisicoPorId.get(pid) || 0;
    stockFisicoPorId.set(pid, acum + (Number(row.cantidad) || 0));
  }

  // Componentes agrupados por combo.
  const componentesPorCombo = new Map();
  for (const c of combos) {
    const arr = componentesPorCombo.get(String(c.combo_codigo)) || [];
    arr.push({ codigo: String(c.componente_codigo), cantidad: Number(c.cantidad) || 1 });
    componentesPorCombo.set(String(c.combo_codigo), arr);
  }

  const combosCodigos = new Set(componentesPorCombo.keys());

  return { porCodigo, porId, stockFisicoPorId, componentesPorCombo, combosCodigos };
}

// ═══════════════════════════════════════════════════════════════════════════
// 2) MOTOR DE CÁLCULO — dado un código, cuánto stock mostrar en la tienda
//    Devuelve { stock, tipo, detalle } o null si el código no existe en Ops.
// ═══════════════════════════════════════════════════════════════════════════

function calcularStock(codigo, ctx, visitados = new Set()) {
  const { porCodigo, porId, stockFisicoPorId, componentesPorCombo } = ctx;
  const p = porCodigo.get(String(codigo).trim());
  if (!p) return null; // no existe en Ops → no se toca en TN

  // Protección anti-bucle (combo que se referencie a sí mismo, etc.)
  if (visitados.has(String(codigo))) return { stock: 0, tipo: 'bucle', detalle: 'referencia circular' };
  visitados.add(String(codigo));

  // ── Caso 1: SOLO ONLINE kilo → deriva del granel via producto_bulk_id ──
  if (p.producto_bulk_id != null) {
    const granel = porId.get(Number(p.producto_bulk_id));
    if (!granel) return { stock: 0, tipo: 'kilo_online', detalle: `granel id ${p.producto_bulk_id} no encontrado` };
    const kg = Number(granel.stock_kg_actual) || 0;
    const kgPorUnidad = Number(p.kg_por_unidad) || 1;
    const disponible = Math.max(0, kg - MARGEN_GRANEL_KG);     // margen de seguridad
    const stock = Math.max(0, Math.floor(disponible / kgPorUnidad));
    return { stock, tipo: 'kilo_online', detalle: `${kg}kg granel − ${MARGEN_GRANEL_KG} ÷ ${kgPorUnidad}` };
  }

  // ── Caso 2: Combo → mínimo de (stock de cada componente ÷ cantidad que lleva) ──
  const comps = componentesPorCombo.get(String(codigo));
  if (comps && comps.length) {
    let min = Infinity;
    let cuelloBotella = null;
    for (const c of comps) {
      const sc = calcularStock(c.codigo, ctx, visitados);
      const stockComp = sc ? sc.stock : 0;         // componente sin datos = 0 (frena el combo)
      const posibles = Math.floor(stockComp / (c.cantidad || 1));
      if (posibles < min) { min = posibles; cuelloBotella = c.codigo; }
    }
    const stock = (min === Infinity) ? 0 : Math.max(0, min);
    return { stock, tipo: 'combo', detalle: `limita el componente ${cuelloBotella}` };
  }

  // ── Caso 3: Granel clásico con código (tipo_venta granel) → stock_kg_actual ──
  if (String(p.tipo_venta || '').toLowerCase() === 'granel') {
    const kg = Number(p.stock_kg_actual) || 0;
    const stock = Math.max(0, Math.floor(kg - MARGEN_GRANEL_KG));
    return { stock, tipo: 'granel', detalle: `${kg}kg − ${MARGEN_GRANEL_KG}` };
  }

  // ── Caso 4: Normal (bolsita) → suma bv1+bv2+bv3 ──
  const suma = stockFisicoPorId.get(Number(p.id)) || 0;
  return { stock: Math.max(0, Math.floor(suma)), tipo: 'normal', detalle: `bv1+bv2+bv3 = ${suma}` };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3) LECTURA DE TIENDA NUBE — todas las variantes con su SKU y stock actual
// ═══════════════════════════════════════════════════════════════════════════

async function tnGet(path) {
  const res = await fetch(`${TN_BASE}${path}`, {
    headers: {
      'Authentication': `bearer ${TN_TOKEN}`,
      'User-Agent': TN_USER_AGENT,
      'Content-Type': 'application/json'
    }
  });
  if (!res.ok) throw new Error(`TN GET ${path} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function cargarVariantesTN() {
  const variantes = [];
  let page = 1;
  while (true) {
    const productos = await tnGet(`/products?fields=id,variants&per_page=200&page=${page}`);
    if (!Array.isArray(productos) || productos.length === 0) break;
    for (const prod of productos) {
      for (const v of (prod.variants || [])) {
        variantes.push({
          product_id: prod.id,
          variant_id: v.id,
          sku: v.sku ? String(v.sku).trim() : null,
          stock_actual: v.stock,                       // puede ser null = ilimitado
          stock_management: v.stock_management !== false, // false = no lleva control de stock
          price: (v.price != null && v.price !== '') ? Number(v.price) : null,
          promotional_price: (v.promotional_price != null && v.promotional_price !== '') ? Number(v.promotional_price) : null
        });
      }
    }
    if (productos.length < 200) break;
    page++;
    await esperar(350); // respeta el rate limit de TN
  }
  return variantes;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4) ESCRITURA EN TIENDA NUBE — setea el stock absoluto de una variante
// ═══════════════════════════════════════════════════════════════════════════

async function tnSetStock(product_id, variant_id, stock) {
  const res = await fetch(`${TN_BASE}/products/${product_id}/variants/${variant_id}`, {
    method: 'PUT',
    headers: {
      'Authentication': `bearer ${TN_TOKEN}`,
      'User-Agent': TN_USER_AGENT,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ stock })
  });
  if (!res.ok) throw new Error(`TN PUT variante ${variant_id} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function tnSetPrice(product_id, variant_id, price) {
  const res = await fetch(`${TN_BASE}/products/${product_id}/variants/${variant_id}`, {
    method: 'PUT',
    headers: {
      'Authentication': `bearer ${TN_TOKEN}`,
      'User-Agent': TN_USER_AGENT,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ price: String(price) })
  });
  if (!res.ok) throw new Error(`TN PUT precio variante ${variant_id} → ${res.status} ${await res.text()}`);
  return res.json();
}

// ═══════════════════════════════════════════════════════════════════════════
// 4.5) AUDITORÍA DE PRECIOS — SOLO LECTURA, nunca escribe en Tienda Nube.
//      Compara precio_venta(Ops) × 1.10 contra el price real en TN, por SKU.
// ═══════════════════════════════════════════════════════════════════════════

function coincidePrecio(esperado, real) {
  const diff = Math.abs(real - esperado);
  const pct = esperado > 0 ? (diff / esperado) * 100 : 0;
  return diff <= TOLERANCIA_PESOS || pct <= TOLERANCIA_PCT;
}

async function auditarPrecios() {
  const ctx = await cargarDatosOps();
  const variantes = await cargarVariantesTN();

  const desviados = [];        // precio de TN no coincide con precio_venta*1.10
  const sinPrecioOps = [];     // SKU existe en Ops pero sin precio_venta cargado
  const sinPrecioTN = [];      // SKU tiene precio_venta en Ops pero TN no tiene price
  const combosOmitidos = [];   // combos: se excluyen del chequeo +10% (precio promo fijo)
  const noEnOps = [];          // SKU de TN que no existe en Ops
  const sinSku = [];           // variantes de TN sin SKU
  let coinciden = 0;

  for (const v of variantes) {
    if (!v.sku) { sinSku.push(v.variant_id); continue; }
    const p = ctx.porCodigo.get(v.sku);
    if (!p) { noEnOps.push(v.sku); continue; }

    if (ctx.combosCodigos.has(v.sku)) { combosOmitidos.push(v.sku); continue; }

    if (p.precio_venta == null) { sinPrecioOps.push({ sku: v.sku, nombre: p.nombre }); continue; }
    if (v.price == null) { sinPrecioTN.push({ sku: v.sku, nombre: p.nombre, precio_ops: p.precio_venta }); continue; }

    const esperado = Math.round(Number(p.precio_venta) * MARGEN_TIENDA * 100) / 100;
    const real = v.price;

    if (coincidePrecio(esperado, real)) { coinciden++; continue; }

    desviados.push({
      sku: v.sku,
      nombre: p.nombre,
      precio_ops: Number(p.precio_venta),
      esperado_en_tn: esperado,
      real_en_tn: real,
      diferencia: Math.round((real - esperado) * 100) / 100,
      diferencia_pct: esperado > 0 ? Math.round(((real - esperado) / esperado) * 10000) / 100 : null,
      promotional_price_tn: v.promotional_price,
      product_id: v.product_id,
      variant_id: v.variant_id
    });
  }

  desviados.sort((a, b) => Math.abs(b.diferencia) - Math.abs(a.diferencia));

  return {
    ts: new Date().toISOString(),
    total_variantes_tn: variantes.length,
    coinciden,
    desviados_cantidad: desviados.length,
    desviados,
    combos_omitidos_cantidad: combosOmitidos.length,
    combos_omitidos: combosOmitidos,
    sin_precio_venta_en_ops: sinPrecioOps,
    sin_precio_en_tn: sinPrecioTN,
    sku_sin_match_en_ops: noEnOps,
    variantes_sin_sku: sinSku.length
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 4.6) CORRECCIÓN PUNTUAL — caso "cero margen aplicado" (TN == precio_ops exacto)
//      Por defecto es DRY RUN (solo reporta). Escribe solo si se pide explícito.
// ═══════════════════════════════════════════════════════════════════════════

async function corregirSinMargen(escribir) {
  const ctx = await cargarDatosOps();
  const variantes = await cargarVariantesTN();

  const candidatos = [];
  for (const v of variantes) {
    if (!v.sku) continue;
    const p = ctx.porCodigo.get(v.sku);
    if (!p) continue;
    if (ctx.combosCodigos.has(v.sku)) continue;
    if (p.precio_venta == null || v.price == null) continue;

    // El caso específico: TN tiene EXACTAMENTE el precio de Ops, sin el +10%.
    if (v.price === Number(p.precio_venta)) {
      const nuevoPrecio = Math.round(Number(p.precio_venta) * MARGEN_TIENDA * 100) / 100;
      candidatos.push({
        sku: v.sku,
        nombre: p.nombre,
        precio_ops: Number(p.precio_venta),
        precio_tn_actual: v.price,
        precio_tn_nuevo: nuevoPrecio,
        product_id: v.product_id,
        variant_id: v.variant_id
      });
    }
  }

  let escritos = 0;
  const erroresEscritura = [];
  if (escribir) {
    for (const c of candidatos) {
      try {
        await tnSetPrice(c.product_id, c.variant_id, c.precio_tn_nuevo);
        escritos++;
        await esperar(400); // rate limit
      } catch (err) {
        erroresEscritura.push({ sku: c.sku, error: err.message });
      }
    }
  }

  return {
    ts: new Date().toISOString(),
    modo: escribir ? 'ESCRITURA REAL' : 'REPORTE (no escribió nada)',
    candidatos_cantidad: candidatos.length,
    candidatos,
    escritos,
    errores_escritura: erroresEscritura
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 4.7) CORRECCIÓN MASIVA — fuerza TODOS los precios (no combo) a precio_venta×1.10
//      Por defecto es DRY RUN (solo reporta). Escribe solo si se pide explícito.
//      A diferencia de corregirSinMargen, esta no distingue el motivo del desvío:
//      simplemente deja cada precio de Tienda Nube exactamente en +10% sobre Ops.
// ═══════════════════════════════════════════════════════════════════════════

async function corregirTodosPrecios(escribir) {
  const ctx = await cargarDatosOps();
  const variantes = await cargarVariantesTN();

  const candidatos = [];
  const sinPrecioOps = [];
  const sinPrecioTN = [];
  let yaCorrectos = 0;

  for (const v of variantes) {
    if (!v.sku) continue;
    const p = ctx.porCodigo.get(v.sku);
    if (!p) continue;
    if (ctx.combosCodigos.has(v.sku)) continue; // combos: precio promocional fijo, no tocar
    if (p.precio_venta == null) { sinPrecioOps.push({ sku: v.sku, nombre: p.nombre }); continue; }
    if (v.price == null) { sinPrecioTN.push({ sku: v.sku, nombre: p.nombre, precio_ops: p.precio_venta }); continue; }

    const nuevoPrecio = Math.round(Number(p.precio_venta) * MARGEN_TIENDA * 100) / 100;

    if (v.price === nuevoPrecio) { yaCorrectos++; continue; }

    candidatos.push({
      sku: v.sku,
      nombre: p.nombre,
      precio_ops: Number(p.precio_venta),
      precio_tn_actual: v.price,
      precio_tn_nuevo: nuevoPrecio,
      diferencia: Math.round((v.price - nuevoPrecio) * 100) / 100,
      // aviso informativo (no bloquea nada): salto grande = vale la pena mirar el producto en TN
      atencion_salto_grande: Math.abs(v.price - nuevoPrecio) > Math.max(500, nuevoPrecio * 0.3),
      product_id: v.product_id,
      variant_id: v.variant_id
    });
  }

  let escritos = 0;
  const erroresEscritura = [];
  if (escribir) {
    for (const c of candidatos) {
      try {
        await tnSetPrice(c.product_id, c.variant_id, c.precio_tn_nuevo);
        escritos++;
        await esperar(400); // rate limit
      } catch (err) {
        erroresEscritura.push({ sku: c.sku, error: err.message });
      }
    }
  }

  return {
    ts: new Date().toISOString(),
    modo: escribir ? 'ESCRITURA REAL' : 'REPORTE (no escribió nada)',
    ya_correctos: yaCorrectos,
    candidatos_cantidad: candidatos.length,
    candidatos,
    sin_precio_venta_en_ops: sinPrecioOps,
    sin_precio_en_tn: sinPrecioTN,
    escritos,
    errores_escritura: erroresEscritura
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 5) CORRIDA COMPLETA — calcula, reporta y (si DRY_RUN=false) escribe
// ═══════════════════════════════════════════════════════════════════════════

async function correr() {
  if (corriendo) { console.log('… corrida anterior todavía en curso, salto esta.'); return; }
  corriendo = true;
  const t0 = Date.now();
  const modo = DRY_RUN ? 'REPORTE (no escribe)' : 'ESCRITURA REAL';
  console.log(`\n══════════════════════════════════════════════════`);
  console.log(`▶ Corrida ${new Date().toISOString()} — modo: ${modo}`);

  try {
    const ctx = await cargarDatosOps();
    const variantes = await cargarVariantesTN();

    const cambios = [];       // { sku, nombre, tipo, de, a }
    const sinSku = [];        // variantes de TN sin SKU
    const noEnOps = [];       // SKU de TN que no existe en Ops
    const sinControl = [];    // SKU con stock_management=false (no guarda stock)
    let iguales = 0;
    const porTipo = { normal: 0, kilo_online: 0, combo: 0, granel: 0 };

    for (const v of variantes) {
      if (!v.sku) { sinSku.push(v.variant_id); continue; }
      const calc = calcularStock(v.sku, ctx);
      if (calc === null) { noEnOps.push(v.sku); continue; }

      porTipo[calc.tipo] = (porTipo[calc.tipo] || 0) + 1;
      if (!v.stock_management) sinControl.push(v.sku);

      const objetivo = calc.stock;
      const actual = (v.stock_actual == null) ? null : Number(v.stock_actual);
      const p = ctx.porCodigo.get(String(v.sku));

      if (actual === objetivo) { iguales++; continue; }
      cambios.push({
        sku: v.sku,
        nombre: p ? p.nombre : '(?)',
        tipo: calc.tipo,
        de: actual,
        a: objetivo,
        detalle: calc.detalle,
        product_id: v.product_id,
        variant_id: v.variant_id
      });
    }

    // ── Diagnóstico de salud del join (si esto da 0, la relación está mal) ──
    const normalesConStock = variantes.filter(v => {
      if (!v.sku) return false;
      const c = calcularStock(v.sku, ctx);
      return c && c.tipo === 'normal' && c.stock > 0;
    }).length;

    // ── Escritura (solo si NO es dry run) ──
    let escritos = 0, erroresEscritura = [];
    if (!DRY_RUN) {
      for (const c of cambios) {
        try {
          await tnSetStock(c.product_id, c.variant_id, c.a);
          escritos++;
          await esperar(400); // rate limit
        } catch (err) {
          erroresEscritura.push({ sku: c.sku, error: err.message });
        }
      }
    }

    // ── Reporte por consola (resumen + muestra + anomalías) ──
    console.log(`  Variantes TN leídas: ${variantes.length}`);
    console.log(`  Por tipo → normal:${porTipo.normal} · kilo_online:${porTipo.kilo_online} · combo:${porTipo.combo} · granel:${porTipo.granel}`);
    console.log(`  Normales con stock > 0: ${normalesConStock}  ${normalesConStock === 0 ? '⚠ SOSPECHOSO: revisar relación stock_sucursal.producto_id ↔ productos.id' : '✓'}`);
    console.log(`  Sin cambios: ${iguales} · Cambiarían: ${cambios.length}`);
    console.log(`  SKU sin match en Ops: ${noEnOps.length} · Variantes sin SKU: ${sinSku.length} · Sin control de stock en TN: ${sinControl.length}`);
    if (!DRY_RUN) console.log(`  Escritos en TN: ${escritos}/${cambios.length} · Errores: ${erroresEscritura.length}`);

    if (cambios.length) {
      console.log('  ── Primeros cambios (hasta 30) ──');
      for (const c of cambios.slice(0, 30)) {
        console.log(`     ${c.sku}  ${(c.nombre||'').slice(0,38).padEnd(38)}  ${String(c.de).padStart(4)} → ${String(c.a).padStart(4)}  [${c.tipo}] ${c.detalle}`);
      }
    }
    if (noEnOps.length) console.log('  ── SKU en TN que NO existen en Ops (primeros 20): ' + noEnOps.slice(0, 20).join(', '));

    ultimoReporte = {
      estado: 'ok',
      modo,
      ts: new Date().toISOString(),
      duracion_ms: Date.now() - t0,
      variantes_tn: variantes.length,
      por_tipo: porTipo,
      normales_con_stock: normalesConStock,
      iguales,
      cambiarian: cambios.length,
      escritos: DRY_RUN ? 0 : escritos,
      errores_escritura: erroresEscritura,
      sku_sin_match_ops: noEnOps,
      variantes_sin_sku: sinSku.length,
      sin_control_stock: sinControl,
      cambios // lista completa (para inspección por GET /reporte)
    };
    console.log(`✔ Corrida OK en ${Date.now() - t0}ms`);
  } catch (err) {
    console.error('✗ Error en la corrida:', err.message);
    ultimoReporte = { estado: 'error', ts: new Date().toISOString(), error: err.message };
  } finally {
    corriendo = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 6) SERVIDOR HTTP mínimo (salud + reporte) + loop cada 15 min
// ═══════════════════════════════════════════════════════════════════════════

function esperar(ms) { return new Promise(r => setTimeout(r, ms)); }

http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.url === '/reporte') {
    res.end(JSON.stringify(ultimoReporte, null, 2));
  } else if (req.url === '/forzar') {
    correr(); // dispara una corrida manual (no espera a que termine)
    res.end(JSON.stringify({ ok: true, mensaje: 'corrida disparada, ver /reporte en unos segundos' }));
  } else if (req.url === '/auditoria-precios') {
    // Solo lectura: nunca escribe en Tienda Nube. Corre sincrónico y devuelve el resultado directo.
    if (auditando) {
      res.end(JSON.stringify({ ok: false, mensaje: 'ya hay una auditoría en curso, esperá unos segundos' }));
      return;
    }
    auditando = true;
    auditarPrecios()
      .then(resultado => {
        ultimaAuditoriaPrecios = { estado: 'ok', ...resultado };
        res.end(JSON.stringify(ultimaAuditoriaPrecios, null, 2));
      })
      .catch(err => {
        ultimaAuditoriaPrecios = { estado: 'error', ts: new Date().toISOString(), error: err.message };
        res.statusCode = 500;
        res.end(JSON.stringify(ultimaAuditoriaPrecios, null, 2));
      })
      .finally(() => { auditando = false; });
  } else if (req.url.startsWith('/corregir-precios-sin-margen')) {
    // Por defecto (sin ?confirmar=si) es SOLO REPORTE: nunca escribe. Hay que pedirlo explícito.
    const escribir = req.url.includes('confirmar=si');
    corregirSinMargen(escribir)
      .then(resultado => res.end(JSON.stringify(resultado, null, 2)))
      .catch(err => {
        res.statusCode = 500;
        res.end(JSON.stringify({ estado: 'error', error: err.message }, null, 2));
      });
  } else if (req.url.startsWith('/corregir-todos-precios')) {
    // Por defecto (sin ?confirmar=si) es SOLO REPORTE: nunca escribe. Hay que pedirlo explícito.
    const escribir = req.url.includes('confirmar=si');
    corregirTodosPrecios(escribir)
      .then(resultado => res.end(JSON.stringify(resultado, null, 2)))
      .catch(err => {
        res.statusCode = 500;
        res.end(JSON.stringify({ estado: 'error', error: err.message }, null, 2));
      });
  } else {
    res.end(JSON.stringify({
      servicio: 'belavita-stock-sync',
      modo: DRY_RUN ? 'REPORTE (DRY_RUN=true)' : 'ESCRITURA REAL',
      intervalo_min: INTERVALO_MIN,
      ultimo: { estado: ultimoReporte.estado, ts: ultimoReporte.ts }
    }, null, 2));
  }
}).listen(PORT, () => console.log(`HTTP escuchando en :${PORT}`));

console.log(`belavita-stock-sync arrancó · modo ${DRY_RUN ? 'REPORTE' : 'ESCRITURA'} · cada ${INTERVALO_MIN} min`);
correr();                                          // primera corrida al arrancar
setInterval(correr, INTERVALO_MIN * 60 * 1000);    // y cada 15 min
