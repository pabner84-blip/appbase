/* =========================================================================
   STOCKFERRE — Consulta rápida de productos (100% frontend)
   Escaneas un código con la cámara (OCR) o lo escribes, y ves al instante:
   código, descripción, marca, categoría, precio de compra y de venta.
   Todo editable. Persistencia: Firebase Firestore (si está configurado en
   firebase-config.js) + LocalStorage como caché/respaldo local. Sin Google Sheets.
   ========================================================================= */

// Claves "viejas" (de cuando la app tenía una sola base de datos, antes de
// dividirse en Herramientas Manuales / Herramientas Eléctricas). Se usan solo
// para migrar automáticamente esos datos hacia Herramientas Manuales una vez.
const LEGACY_STORAGE_KEY = 'stockferre_catalogo_v1';
const LEGACY_INV_UPDATES_KEY = 'stockferre_inv_actualizaciones_v1';

// currentModo: 'manual' (Herramientas Manuales) o 'electrico' (Herramientas
// Eléctricas). Cada modo tiene su PROPIA base de datos (LocalStorage y
// Firebase separados) para que sean como "dos apps iguales" independientes.
let currentModo = 'manual';
// currentRole: 'admin' (dueño, entra con o sin contraseña) o 'guest'
// (invitado: no ve precios de compra/marca ni puede entrar a Inventario o
// Configuración).
let currentRole = 'admin';
// Vista activa actual (para saber si el usuario está en una pestaña exclusiva
// del modo pro cuando este se desactiva).
let currentView = 'inicio';
// Temporizador de la pantalla de bienvenida: la deja 1 segundo y salta sola a
// la pestaña Productos. Se cancela si el usuario navega antes de que termine.
let welcomeTimer = null;
// Edición de ventas: mientras el modal de venta está en modo "editar" se
// guardan aquí el id de la venta y a qué modo pertenece (para el invitado).
let editingVentaId = null;
let editingVentaModo = null;

function storageKey(){ return 'stockferre_catalogo_v1_' + currentModo; }
function invUpdatesKey(){ return 'stockferre_inv_actualizaciones_v1_' + currentModo; }

let db = null;
let invUpdates = {};

function loadInvUpdates(){
  try{
    let raw = localStorage.getItem(invUpdatesKey());
    if(!raw && currentModo === 'manual'){
      raw = localStorage.getItem(LEGACY_INV_UPDATES_KEY); // migración única
    }
    invUpdates = raw ? JSON.parse(raw) : {};
  }catch(e){
    console.error('Error leyendo actualizaciones de inventario', e);
    invUpdates = {};
  }
}

function saveInvUpdates(){
  try{
    localStorage.setItem(invUpdatesKey(), JSON.stringify(invUpdates));
  }catch(e){
    console.error('Error guardando actualizaciones de inventario', e);
  }
}

function markInventarioActualizado(productoId){
  // Timestamp completo (fecha + hora) para poder ordenar la pestaña por los
  // últimos productos registrados en este dispositivo, no solo por fecha.
  invUpdates[productoId] = new Date().toISOString();
  saveInvUpdates();
}

/* -------------------------------------------------------------------------
   1. MODELO DE DATOS + PERSISTENCIA (Firebase + LocalStorage)
   ------------------------------------------------------------------------- */

function defaultDB(){
  return {
    productos: [],
    categorias: [],
    contador: { producto: 1, venta: 1 },
    historialEscaneos: [],
    historialBusquedas: [],
    historialInventario: [],
    ventas: [],
    compras: [],
    gastos: [],
    gastosPrestamos: [],
    finanzas: { caja: 0, retiros: [], deudas: [] }
  };
}

function normalizeDB(obj){
  obj = obj || {};
  obj.productos = obj.productos || [];
  obj.categorias = obj.categorias || [];
  obj.contador = obj.contador || { producto: 1, venta: 1 };
  obj.contador.venta = obj.contador.venta || 1;
  obj.contador.producto = obj.contador.producto || 1;
  obj.historialEscaneos = obj.historialEscaneos || [];
  obj.historialBusquedas = obj.historialBusquedas || [];
  obj.historialInventario = obj.historialInventario || [];
  obj.ventas = obj.ventas || [];
  obj.compras = obj.compras || [];
  obj.gastos = obj.gastos || [];
  obj.gastosPrestamos = obj.gastosPrestamos || [];
  obj.finanzas = obj.finanzas || {};
  obj.finanzas.caja = typeof obj.finanzas.caja === 'number' ? obj.finanzas.caja : 0;
  obj.finanzas.retiros = obj.finanzas.retiros || [];
  obj.finanzas.deudas = obj.finanzas.deudas || [];
  obj.productos.forEach(p=>{
    p.codigoBarras = p.codigoBarras || '';
    p.stock = typeof p.stock === 'number' ? p.stock : 0;
    p.stockMin = typeof p.stockMin === 'number' ? p.stockMin : 0;
    // Marca de tiempo del último cambio de ESTE producto (stock, precio, etc.).
    // Se usa para resolver conflictos cuando dos dispositivos editan al mismo
    // tiempo: gana el cambio con la marca más reciente, en vez de que "el que
    // termine de guardar último" borre silenciosamente al otro.
    p._updatedAt = typeof p._updatedAt === 'number' ? p._updatedAt : 0;
  });
  return obj;
}

// Se llama SIEMPRE que se modifica un producto (stock, precio, datos) para
// poder resolver conflictos de sincronización a nivel de producto.
function touchProducto(p){
  if(p) p._updatedAt = Date.now();
  return p;
}

// Carga inicial: siempre desde LocalStorage (instantáneo, funciona sin internet).
// Si Firebase está configurado, connectFirebase() la reemplaza/sincroniza después.
function loadDB(){
  if(currentModo === 'invitado'){ db = buildGuestDB(); return; } // vista combinada de ambos modos
  try{
    let raw = localStorage.getItem(storageKey());
    if(!raw && currentModo === 'manual'){
      raw = localStorage.getItem(LEGACY_STORAGE_KEY); // migración única
    }
    if(raw){ db = normalizeDB(JSON.parse(raw)); persistLocalCache(); return; }
  }catch(e){ console.error('Error leyendo LocalStorage', e); }
  db = defaultDB();
  persistLocalCache();
}

function persistLocalCache(){
  if(currentModo === 'invitado') return; // el invitado no tiene base propia
  try{
    localStorage.setItem(storageKey(), JSON.stringify(db));
  }catch(e){
    console.error('Error guardando en LocalStorage', e);
    toast('No se pudo guardar en el almacenamiento local (¿espacio lleno?)', 'error');
  }
}

// Guarda siempre en LocalStorage (instantáneo) y, si Firebase está conectado,
// también sube los datos a Firestore para que se vean en todos los dispositivos.
// El historial de escaneos/búsquedas se queda solo en este dispositivo (no se
// sube) para no gastar la cuota gratuita de Firebase con cada escaneo.
/* -------------------------------------------------------------------------
   COLA DE ESCRITURAS A FIREBASE
   -------------------------------------------------------------------------
   PROBLEMA que esto arregla: antes, cada saveDB()/persistModoDB() disparaba
   un fbDocRef.set(...) inmediato. Si el usuario registraba productos muy
   rápido (ej. escaneando un inventario de 1000+ artículos), se disparaban
   varias escrituras a la vez sin esperar a que terminara la anterior. Por la
   red, esas escrituras podían llegar al servidor en un orden distinto al que
   se enviaron: una escritura más "vieja" (con menos productos actualizados)
   podía llegar DESPUÉS que una más nueva y sobrescribirla, borrando así el
   último cambio aunque ya se hubiera aplicado localmente (por eso aparecía
   en el Historial pero el producto no quedaba actualizado).

   La solución: por cada documento de Firestore solo dejamos UNA escritura en
   curso a la vez. Si llegan más cambios mientras esa escritura está en
   camino, no se disparan escrituras nuevas de inmediato: se espera a que
   termine la actual y entonces se manda UNA sola escritura más, con el
   estado más reciente de la base de datos en ese momento. Así nunca se puede
   sobrescribir un cambio nuevo con uno viejo, sin importar la velocidad a la
   que se registren productos ni la latencia de la red.
   ------------------------------------------------------------------------- */
const fbWriteQueues = {}; // docId -> { inFlight: bool, latestData: object }

function scheduleFirestoreWrite(docId, ref, data){
  let q = fbWriteQueues[docId];
  if(!q){ q = fbWriteQueues[docId] = { inFlight: false, latestData: null }; }
  q.latestData = data; // siempre nos quedamos con la versión más reciente conocida
  if(q.inFlight) return; // ya hay una escritura en camino; cuando termine, tomará latestData
  runQueuedWrite(docId, ref);
}

function runQueuedWrite(docId, ref){
  const q = fbWriteQueues[docId];
  if(!q) return;
  q.inFlight = true;
  const toSend = q.latestData;
  setSyncStatus('connecting');
  ref.set(toSend).then(()=>{
    setSyncStatus('synced');
  }).catch(err=>{
    console.error('Error guardando en Firebase', err);
    setSyncStatus('error');
  }).finally(()=>{
    q.inFlight = false;
    // Si mientras escribíamos llegó un cambio más nuevo, lo mandamos ahora.
    if(q.latestData !== toSend){ runQueuedWrite(docId, ref); }
  });
}

function saveDB(){
  if(currentModo === 'invitado') return; // el invitado no escribe sobre las bases de cada modo
  persistLocalCache();
  if(fbReady && fbDocRef){
    const { historialEscaneos, historialBusquedas, historialInventario, ...syncData } = db;
    scheduleFirestoreWrite(firebaseDocId(), fbDocRef, syncData);
  }
}

/* -------------------------------------------------------------------------
   1a. MODO INVITADO: catálogo combinado de ambos modos + escritura dirigida
   El invitado NO tiene base de datos propia: lee los productos de
   Herramientas Manuales y Herramientas Eléctricas y los combina en una vista
   única. Las ventas que registra se guardan en la base del modo al que
   pertenece el producto (o el que elija para "OTRO"), para que el dueño las
   vea en la pestaña Ventas de cada modo.
   ------------------------------------------------------------------------- */

// Historiales de la sesión del invitado (solo en memoria: se borran al salir)
let guestSessionScans = [];
let guestSessionSearches = [];
let guestSessionInventory = [];

// Lee la base completa de UN modo concreto desde LocalStorage.
function loadModoDB(modo){
  let raw = null;
  try{ raw = localStorage.getItem('stockferre_catalogo_v1_' + modo); }catch(e){}
  if(!raw && modo === 'manual'){ try{ raw = localStorage.getItem(LEGACY_STORAGE_KEY); }catch(e){} }
  if(raw){ try{ return normalizeDB(JSON.parse(raw)); }catch(e){ return defaultDB(); } }
  return defaultDB();
}

// Arma la vista combinada del invitado: productos de ambos modos (marcados
// con modoOrigin para saber a qué base pertenece cada uno) y ventas unidas.
function buildGuestDB(){
  const m = loadModoDB('manual');
  const e = loadModoDB('electrico');
  const merged = defaultDB();
  merged.productos = [
    ...m.productos.map(p => Object.assign({}, p, { modoOrigin: 'manual' })),
    ...e.productos.map(p => Object.assign({}, p, { modoOrigin: 'electrico' }))
  ];
  merged.categorias = Array.from(new Set(m.categorias.concat(e.categorias).map(c => String(c||'').trim()).filter(Boolean)));
  merged.ventas = [
    ...m.ventas.map(v => Object.assign({}, v, { modo: 'manual' })),
    ...e.ventas.map(v => Object.assign({}, v, { modo: 'electrico' }))
  ].sort((a,b)=> new Date(b.fecha) - new Date(a.fecha));
  merged.gastosPrestamos = dedupeGastosById([
    ...(m.gastosPrestamos||[]).map(g => Object.assign({}, g, { modo: g.modo || 'manual' })),
    ...(e.gastosPrestamos||[]).map(g => Object.assign({}, g, { modo: g.modo || 'electrico' })),
    ...loadGuestNeutralGastos()
  ]);
  merged.historialEscaneos = guestSessionScans;
  merged.historialBusquedas = guestSessionSearches;
  merged.historialInventario = guestSessionInventory;
  return merged;
}

// Busca por código/código de barras DENTRO de una base específica.
function findProductoInDB(dbObj, codigo){
  const c = normalize(codigo);
  if(!c) return null;
  return dbObj.productos.find(p => normalize(p.codigo) === c || (p.codigoBarras && normalize(p.codigoBarras) === c)) || null;
}

// Guarda la base de UN modo concreto (LocalStorage + Firebase), sin depender
// del modo actual. Lo usa el invitado para que sus ventas queden en la base
// correcta (Manuales o Eléctricas).
function persistModoDB(modo, dbObj){
  try{ localStorage.setItem('stockferre_catalogo_v1_' + modo, JSON.stringify(dbObj)); }catch(e){}
  if(typeof firebase !== 'undefined' && typeof firebaseConfig !== 'undefined' && firebaseConfig.apiKey){
    try{
      if(!firebase.apps || !firebase.apps.length){ firebase.initializeApp(firebaseConfig); }
      const ref = firebase.firestore().collection('stockferre').doc('inventario_' + modo);
      const { historialEscaneos, historialBusquedas, historialInventario, ...syncData } = dbObj;
      scheduleFirestoreWrite('inventario_' + modo, ref, syncData);
    }catch(err){
      console.error('Error guardando en Firebase', err);
    }
  }
}

/* -------------------------------------------------------------------------
   FUSIÓN DE DATOS REMOTOS (evita perder cambios cuando DOS dispositivos
   distintos escriben casi al mismo tiempo)
   -------------------------------------------------------------------------
   Antes, cuando llegaba una copia nueva desde Firebase (otro dispositivo
   guardó algo), la app hacía "db = remote" y reemplazaba TODO lo que había
   en memoria, incluso si ese remoto todavía no incluía un cambio que este
   mismo dispositivo acababa de hacer un instante antes. Eso también podía
   borrar en pantalla (y en el siguiente guardado) un producto recién
   registrado.

   Ahora, en vez de reemplazar, se FUSIONA: se compara registro por registro
   usando su "id" único.
   ------------------------------------------------------------------------- */

// Combina un arreglo LOCAL con uno REMOTO por id, sin perder ningún registro:
// - Si un id solo existe en un lado, se conserva.
// - Si existe en ambos y se pasa un campo de marca de tiempo, gana el más
//   reciente (ej. productos, que se editan en el mismo registro varias veces).
// - Si existe en ambos y no hay marca de tiempo (ventas, compras, etc., que
//   normalmente solo se agregan una vez), se conserva la versión local para
//   no perder una edición reciente que el remoto aún no vio.
function mergeById(localArr, remoteArr, timestampField){
  localArr = Array.isArray(localArr) ? localArr : [];
  remoteArr = Array.isArray(remoteArr) ? remoteArr : [];
  const map = new Map();
  remoteArr.forEach(item => { if(item && item.id != null) map.set(item.id, item); });
  localArr.forEach(item => {
    if(!item || item.id == null) return;
    const remoteItem = map.get(item.id);
    if(!remoteItem){ map.set(item.id, item); return; }
    if(timestampField){
      const lt = item[timestampField] || 0;
      const rt = remoteItem[timestampField] || 0;
      map.set(item.id, lt >= rt ? item : remoteItem);
    }else{
      map.set(item.id, item);
    }
  });
  return Array.from(map.values());
}

// Fusiona la base LOCAL (lo que tenemos en memoria/LocalStorage, que puede
// incluir cambios recién hechos aquí) con una copia REMOTA que acaba de
// llegar de Firebase. Devuelve una base combinada que no pierde datos de
// ningún lado.
function mergeRemoteIntoLocal(local, remote){
  local = normalizeDB(Object.assign({}, local || defaultDB()));
  remote = normalizeDB(Object.assign({}, remote || defaultDB()));
  const merged = Object.assign({}, remote);
  merged.productos = mergeById(local.productos, remote.productos, '_updatedAt');
  merged.categorias = Array.from(new Set(
    (local.categorias||[]).concat(remote.categorias||[])
      .map(c => String(c||'').trim()).filter(Boolean)
  ));
  merged.ventas = mergeById(local.ventas, remote.ventas);
  merged.compras = mergeById(local.compras, remote.compras);
  merged.gastos = mergeById(local.gastos, remote.gastos);
  merged.gastosPrestamos = mergeById(local.gastosPrestamos, remote.gastosPrestamos);
  merged.finanzas = Object.assign({}, remote.finanzas);
  merged.finanzas.retiros = mergeById((local.finanzas||{}).retiros, (remote.finanzas||{}).retiros);
  merged.finanzas.deudas = mergeById((local.finanzas||{}).deudas, (remote.finanzas||{}).deudas);
  // Los contadores usados para generar ids nuevos: se toma el mayor de los
  // dos para que dos dispositivos creando productos/ventas nuevas al mismo
  // tiempo nunca terminen usando el mismo id.
  merged.contador = {
    producto: Math.max((local.contador||{}).producto || 1, (remote.contador||{}).producto || 1),
    venta: Math.max((local.contador||{}).venta || 1, (remote.contador||{}).venta || 1)
  };
  return normalizeDB(merged);
}

let guestUnsubs = [];
function disconnectGuestFirebase(){
  guestUnsubs.forEach(u => { try{ u(); }catch(e){ /* ignorar */ } });
  guestUnsubs = [];
}

// En modo invitado conecta a Firestore de ambos modos (lectura + escucha)
// para que el invitado vea datos recientes; las escrituras van por
// persistModoDB() al documento del modo correcto.
function connectGuestFirebase(){
  if(typeof firebaseConfig === 'undefined' || !firebaseConfig.apiKey || !firebaseConfig.projectId) return;
  if(typeof firebase === 'undefined') return;
  try{
    if(!firebase.apps || !firebase.apps.length){ firebase.initializeApp(firebaseConfig); }
    const fbFirestore = firebase.firestore();
    enableOfflinePersistence(fbFirestore); // no bloquea la conexión
    ['manual','electrico'].forEach(modo => {
      const ref = fbFirestore.collection('stockferre').doc('inventario_' + modo);
      ref.get().then(snap=>{
        if(snap.exists){
          const prev = loadModoDB(modo);
          const remote = normalizeDB(snap.data());
          const merged = mergeRemoteIntoLocal(prev, remote);
          merged.historialEscaneos = prev.historialEscaneos;
          merged.historialBusquedas = prev.historialBusquedas;
          merged.historialInventario = prev.historialInventario;
          try{ localStorage.setItem('stockferre_catalogo_v1_' + modo, JSON.stringify(merged)); }catch(e){}
          if(currentModo === 'invitado'){ db = buildGuestDB(); rerenderCurrentView(); }
        }
      }).catch(()=>{ /* local sigue funcionando */ });
      const unsub = ref.onSnapshot(snap=>{
        if(snap.metadata.hasPendingWrites) return;
        if(!snap.exists) return;
        const prev = loadModoDB(modo);
        const remote = normalizeDB(snap.data());
        const merged = mergeRemoteIntoLocal(prev, remote);
        merged.historialEscaneos = prev.historialEscaneos;
        merged.historialBusquedas = prev.historialBusquedas;
        merged.historialInventario = prev.historialInventario;
        try{ localStorage.setItem('stockferre_catalogo_v1_' + modo, JSON.stringify(merged)); }catch(e){}
        if(currentModo === 'invitado'){ db = buildGuestDB(); rerenderCurrentView(); }
      }, ()=>{ /* ignorar */ });
      guestUnsubs.push(unsub);
      // Documentos de productos (stock atómico): crea los que falten y
      // mantiene el stock local al día con el valor exacto de la nube.
      backfillProductos(modo);
      startStockListener(modo);
    });
  }catch(err){
    console.error('No se pudo conectar a Firebase en modo invitado', err);
  }
}

/* -------------------------------------------------------------------------
   1b. FIREBASE (sincronización entre dispositivos — opcional)
   ------------------------------------------------------------------------- */

let fbReady = false;
let fbDocRef = null;
let fbUnsub = null;
let fbOtherUnsub = null; // suscripción al OTRO modo (mantiene su contraseña/datos en caché)

// Cada modo se guarda en un documento de Firestore distinto para que sean
// bases de datos completamente separadas dentro del mismo proyecto.
function firebaseDocId(){ return 'inventario_' + currentModo; }

function disconnectFirebase(){
  if(fbUnsub){ try{ fbUnsub(); }catch(e){ /* ignorar */ } fbUnsub = null; }
  if(fbOtherUnsub){ try{ fbOtherUnsub(); }catch(e){ /* ignorar */ } fbOtherUnsub = null; }
  stopStockListeners();
  fbReady = false;
  fbDocRef = null;
}

function setSyncStatus(status){
  const el = document.getElementById('sidebarSyncStatus');
  if(!el) return;
  const labels = {
    local: '💾 Solo en este dispositivo',
    connecting: '🔄 Conectando a Firebase...',
    synced: '🔥 Sincronizado con Firebase',
    error: '⚠️ Error de sincronización'
  };
  el.textContent = labels[status] || '';
}

function rerenderCurrentView(){
  const activeView = document.querySelector('.view.active');
  if(!activeView) return;
  const name = activeView.id.replace('view-', '');
  if(name === 'productos') renderProductos();
  if(name === 'categorias') renderCategorias();
  if(name === 'ventas') renderVentas();
  if(name === 'topventas') renderTopVentas();
  if(name === 'pedidos') renderPedidos();
  if(name === 'compras') renderCompras();
  if(name === 'finanzas') renderFinanzas();
  if(name === 'retiros') renderRetiros();
  if(name === 'deudas') renderDeudas();
  if(name === 'gastos') renderGastos();
  if(name === 'historial') renderHistorial();
  if(name === 'inventario') renderInventario();
  updateSidebarProductCount();
}

async function connectFirebase(){
  if(typeof firebaseConfig === 'undefined' || !firebaseConfig.apiKey || !firebaseConfig.projectId){
    setSyncStatus('local');
    return; // no configurado: la app sigue funcionando 100% local
  }
  if(typeof firebase === 'undefined'){
    console.warn('El SDK de Firebase no cargó (revisa tu conexión a internet)');
    setSyncStatus('error');
    return;
  }

  try{
    setSyncStatus('connecting');
    if(!firebase.apps || !firebase.apps.length){ firebase.initializeApp(firebaseConfig); }
    const fbFirestore = firebase.firestore();
    await enableOfflinePersistence(fbFirestore);
    fbDocRef = fbFirestore.collection('stockferre').doc(firebaseDocId());
    fbReady = true;

    const snap = await fbDocRef.get();
    if(snap.exists){
      // Ya hay datos en la nube: se fusionan con lo que tengamos localmente
      // (por si este dispositivo tenía cambios que la nube todavía no vio),
      // manteniendo siempre el historial local.
      const remote = normalizeDB(snap.data());
      const merged = mergeRemoteIntoLocal(db, remote);
      merged.historialEscaneos = db.historialEscaneos;
      merged.historialBusquedas = db.historialBusquedas;
      merged.historialInventario = db.historialInventario;
      db = merged;
      persistLocalCache();
      rerenderCurrentView();
    }else{
      // Primera vez: sube los datos locales como semilla inicial de la nube
      const { historialEscaneos, historialBusquedas, historialInventario, ...syncData } = db;
      await fbDocRef.set(syncData);
    }

    fbUnsub = fbDocRef.onSnapshot(snap=>{
      if(snap.metadata.hasPendingWrites) return; // es un cambio que hicimos nosotros mismos
      if(!snap.exists) return;
      const prevVentas = (db.ventas || []).map(v => v.id);
      const remote = normalizeDB(snap.data());
      const merged = mergeRemoteIntoLocal(db, remote);
      merged.historialEscaneos = db.historialEscaneos;
      merged.historialBusquedas = db.historialBusquedas;
      merged.historialInventario = db.historialInventario;
      db = merged;
      persistLocalCache();
      rerenderCurrentView();
      notifyNewRemoteSales(prevVentas, merged.ventas); // avisa ventas hechas en otro dispositivo
      setSyncStatus('synced');
    }, err=>{
      console.error('Error de sincronización Firebase', err);
      setSyncStatus('error');
    });

    setSyncStatus('synced');

    // Mantiene también en caché el OTRO modo (Manuales ↔ Eléctricas). Así la
    // contraseña y los datos de ambos quedan listos en este dispositivo aunque
    // todavía no hayas entrado en ese modo (clave para pedir la contraseña
    // desde la pantalla de Inicio en un celular recién configurado).
    const otherModo = currentModo === 'manual' ? 'electrico' : 'manual';
    try{
      const otherRef = fbFirestore.collection('stockferre').doc('inventario_' + otherModo);
      const otherSnap = await otherRef.get();
      if(otherSnap.exists) cacheRemoteModo(otherSnap.data(), otherModo);
      fbOtherUnsub = otherRef.onSnapshot(snap=>{
        if(snap.metadata.hasPendingWrites) return;
        if(snap.exists) cacheRemoteModo(snap.data(), otherModo);
      }, ()=>{ /* ignorar */ });
    }catch(err){ /* la caché del otro modo es opcional */ }

    // Stock atómico: crea los documentos de producto que falten (los que ya
    // existían antes de este arreglo) y escucha la colección para mantener el
    // stock local al día con el valor EXACTO de la nube.
    try{ await backfillProductos(currentModo); }catch(e){ /* no bloquea */ }
    try{ await backfillProductos(otherModo); }catch(e){ /* no bloquea */ }
    startStockListener(currentModo);
    startStockListener(otherModo);
  }catch(err){
    console.error('No se pudo conectar a Firebase', err);
    setSyncStatus('error');
  }
}

// Guarda en LocalStorage los datos de UN modo recibidos de Firebase,
// conservando los historiales locales de ese modo.
function cacheRemoteModo(data, modo){
  try{
    const prev = loadModoDB(modo);
    const remote = normalizeDB(data);
    const merged = mergeRemoteIntoLocal(prev, remote);
    merged.historialEscaneos = prev.historialEscaneos;
    merged.historialBusquedas = prev.historialBusquedas;
    merged.historialInventario = prev.historialInventario;
    localStorage.setItem('stockferre_catalogo_v1_' + modo, JSON.stringify(merged));
  }catch(e){ /* ignorar */ }
}



/* -------------------------------------------------------------------------
   1c. STOCK EN LA NUBE: UN DOCUMENTO POR PRODUCTO + INCREMENTOS ATÓMICOS
   -------------------------------------------------------------------------
   EL PROBLEMA que arregla esto:
   Antes, TODO (incluido el stock de cada producto) se guardaba en UN solo
   documento de Firestore (stockferre/inventario_<modo>). Eso producía los
   fallos que viste al registrar el inventario:
     • Si DOS celulares registraban cantidades casi al mismo tiempo, el que
       escribía al final PISABA al otro (se perdía un registro). Por eso a
       veces "aparecía en el historial" pero el stock no quedaba.
     • Si la red fallaba un instante, la escritura completa se perdía en la
       nube (pero quedaba en el historial local de ese celular).
     • Al recargar, cada celular mezclaba su copia vieja con la nube con
       marcas de tiempo, y quedaban valores distintos (3 vs 4).

   LA SOLUCIÓN:
   • Cada producto tiene SU PROPIO documento en la colección
     "stockferre_productos_<modo>". Esos documentos son pequeños y nunca
     chocan entre sí.
   • Los cambios de stock se aplican con FieldValue.increment() DENTRO de
     Firestore: si dos celulares suman +1 a la vez, Firestore suma +1 y +1
     (nunca se pierde un registro).
   • La persistencia offline guarda las escrituras pendientes y las reenvía
     cuando vuelve la conexión (ya no se pierde un registro por un cortón).
   • Este celular ESCUCHA la colección (onSnapshot) y corrige su stock local
     con el valor exacto que tiene la nube, así todos los dispositivos
     terminan mostrando lo mismo.
   ------------------------------------------------------------------------- */

// ¿Firebase está configurado y listo para escribir?
function fbConfigOk(){
  return typeof firebaseConfig !== 'undefined' && firebaseConfig &&
    firebaseConfig.apiKey && firebaseConfig.projectId &&
    typeof firebase !== 'undefined' && firebase.firestore;
}

function fbFirestoreOrNull(){
  if(!fbConfigOk()) return null;
  try{
    if(!firebase.apps || !firebase.apps.length){ firebase.initializeApp(firebaseConfig); }
    const fs = firebase.firestore();
    // Red de seguridad: activa la persistencia offline también por esta vía
    // (por si se escribe stock antes de que termine connectFirebase). La
    // función es idempotente, así que no duplica nada.
    enableOfflinePersistence(fs);
    return fs;
  }catch(e){ console.error('Error preparando Firestore', e); return null; }
}

// Colección de documentos por producto del modo dado (o del modo actual).
function fbProductsCol(modo){
  const fs = fbFirestoreOrNull();
  return fs ? fs.collection('stockferre_productos_' + (modo || currentModo)) : null;
}

// Datos que se guardan en el documento del producto.
function productoDocData(p){
  return {
    id: p.id,
    codigo: p.codigo || '',
    nombre: p.nombre || '',
    marca: p.marca || '',
    categoria: p.categoria || '',
    codigoBarras: p.codigoBarras || '',
    precioCompra: Number(p.precioCompra) || 0,
    precioMarca: Number(p.precioMarca) || 0,
    precioVenta: Number(p.precioVenta) || 0,
    stock: Number(p.stock) || 0,
    stockMin: Number(p.stockMin) || 0,
    _updatedAt: typeof p._updatedAt === 'number' ? p._updatedAt : Date.now()
  };
}

// Crea (si no existe) el documento del producto SIN tocar su stock: el stock
// solo se modifica con incrementos atómicos para no pisar a otro dispositivo.
async function ensureProductoDoc(p, modo){
  const col = fbProductsCol(modo);
  if(!col || !p || !p.id) return false;
  try{
    const data = productoDocData(p);
    delete data.stock; // el stock se maneja con incrementos, no con reemplazo
    await col.doc(p.id).set(data, { merge: true });
    return true;
  }catch(e){ console.error('Error creando documento del producto en la nube', e); return false; }
}

// Aplica un cambio ATÓMICO de stock en la nube (suma o resta). Esto es lo que
// evita que dos celulares se pisen: Firestore suma la cantidad sobre el valor
// actual que tenga en ese momento, así que ningún registro se pierde.
async function applyStockDelta(p, delta, modo){
  const col = fbProductsCol(modo);
  if(!col || !p || !p.id) return;
  delta = Number(delta) || 0;
  if(delta === 0) return;
  try{
    await col.doc(p.id).update({
      stock: firebase.firestore.FieldValue.increment(delta),
      _updatedAt: Date.now()
    });
  }catch(err){
    if(err && err.code === 'not-found'){
      // Producto creado antes de esta actualización: se crea su documento
      // primero y luego se aplica el incremento sobre el stock de la nube.
      await ensureProductoDoc(p, modo);
      try{
        await col.doc(p.id).update({
          stock: firebase.firestore.FieldValue.increment(delta),
          _updatedAt: Date.now()
        });
      }catch(e2){ console.error('Error incrementando stock tras crear documento', e2); }
    }else{
      // Con la persistencia offline, un fallo transitorio de red se reenvía
      // solo; si falla por otra razón, este celular conserva su valor local.
      console.error('Error aplicando cambio de stock en la nube', err);
    }
  }
}

// Guarda el stock EXACTO de un producto (para correcciones manuales o CSV).
// Se usa solo cuando el usuario dice explícitamente "este es el stock real".
async function applyStockAbsolute(p, value, modo){
  const col = fbProductsCol(modo);
  if(!col || !p || !p.id) return;
  const data = productoDocData(p);
  data.stock = Number(value) || 0;
  data._updatedAt = Date.now();
  try{
    await col.doc(p.id).set(data, { merge: true });
  }catch(e){ console.error('Error guardando stock exacto en la nube', e); }
}

// Guarda (crea o actualiza) el documento completo de un producto.
async function syncProductoDoc(p, modo){
  const col = fbProductsCol(modo);
  if(!col || !p || !p.id) return;
  try{
    await col.doc(p.id).set(productoDocData(p), { merge: true });
  }catch(e){ console.error('Error sincronizando producto en la nube', e); }
}

async function deleteProductoDoc(p, modo){
  const col = fbProductsCol(modo);
  if(!col || !p || !p.id) return;
  try{
    await col.doc(p.id).delete();
  }catch(e){ console.error('Error borrando producto de la nube', e); }
}

// Crea los documentos de los productos locales que todavía no tienen uno en
// la nube (por ejemplo, los 1000+ productos que ya existían antes de este
// arreglo). Es idempotente: solo crea los que faltan, sin tocar los stocks.
async function backfillProductos(modo){
  const col = fbProductsCol(modo);
  if(!col) return;
  const local = modo === currentModo ? db : loadModoDB(modo);
  const arr = (local && local.productos) || [];
  if(arr.length === 0) return;
  try{
    const snap = await col.get();
    const existing = new Set(snap.docs.map(d => d.id));
    const missing = arr.filter(p => p && p.id && !existing.has(p.id));
    if(missing.length === 0) return;
    const fs = firebase.firestore();
    for(let i = 0; i < missing.length; i += 450){
      const batch = fs.batch();
      missing.slice(i, i + 450).forEach(p => {
        const data = productoDocData(p);
        delete data.stock; // el stock se sincroniza después con incrementos
        batch.set(col.doc(p.id), data, { merge: true });
      });
      await batch.commit();
    }
  }catch(e){ console.error('Error respaldando productos en la nube', e); }
}

// Escribe los documentos de una lista de productos (para importaciones CSV).
async function syncProductoDocs(list, modo){
  const col = fbProductsCol(modo);
  if(!col || !list || !list.length) return;
  try{
    const fs = firebase.firestore();
    for(let i = 0; i < list.length; i += 450){
      const batch = fs.batch();
      list.slice(i, i + 450).forEach(p => {
        if(!p || !p.id) return;
        batch.set(col.doc(p.id), productoDocData(p), { merge: true });
      });
      await batch.commit();
    }
  }catch(e){ console.error('Error sincronizando lista de productos en la nube', e); }
}

// Escucha los documentos de productos de un modo y corrige el stock local con
// el valor EXACTO que tiene la nube. Así dos celulares que registraron a la
// vez terminan mostrando la misma cantidad (la que Firestore sumó de verdad).
const fbProductosUnsubs = {};   // modo -> función para dejar de escuchar
const stockStoreCache = {};     // modo -> copia de la base mientras se actualiza

function startStockListener(modo){
  const col = fbProductsCol(modo);
  if(!col) return;
  if(fbProductosUnsubs[modo]){ try{ fbProductosUnsubs[modo](); }catch(e){ /* ignorar */ } }
  stockStoreCache[modo] = null;
  let timer = null, changed = false;

  const flush = () => {
    if(!changed) return;
    changed = false;
    const store = stockStoreCache[modo];
    if(store){
      try{
        if(modo === currentModo){
          persistLocalCache();
        }else{
          localStorage.setItem('stockferre_catalogo_v1_' + modo, JSON.stringify(store));
        }
      }catch(e){ console.error('Error guardando stock local', e); }
    }
    stockStoreCache[modo] = null;
    if(modo === currentModo){
      rerenderCurrentView();
    }else if(currentModo === 'invitado'){
      db = buildGuestDB();
      rerenderCurrentView();
    }
  };

  fbProductosUnsubs[modo] = col.onSnapshot(snap => {
    snap.docChanges().forEach(ch => {
      if(ch.type === 'removed' || ch.doc.metadata.hasPendingWrites) return;
      const data = ch.doc.data();
      if(!data || !data.id) return;
      if(!stockStoreCache[modo]){
        try{
          stockStoreCache[modo] = modo === currentModo ? db : loadModoDB(modo);
        }catch(e){ return; }
      }
      const store = stockStoreCache[modo];
      if(!store) return;
      const p = store.productos.find(x => x && x.id === data.id);
      if(!p) return;
      let touched = false;
      if(typeof data.stock === 'number' && data.stock !== p.stock){
        p.stock = data.stock;
        touched = true;
      }
      if(typeof data.codigoBarras === 'string' && data.codigoBarras && data.codigoBarras !== p.codigoBarras){
        p.codigoBarras = data.codigoBarras;
        touched = true;
      }
      if(touched) changed = true;
    });
    if(changed){
      if(timer) clearTimeout(timer);
      timer = setTimeout(()=>{ timer = null; flush(); }, 60);
    }
  }, err => {
    console.error('Error escuchando stock de productos (' + modo + ')', err);
  });
}

function stopStockListeners(){
  Object.keys(fbProductosUnsubs).forEach(modo => {
    try{ fbProductosUnsubs[modo](); }catch(e){ /* ignorar */ }
  });
  Object.keys(stockStoreCache).forEach(k => { stockStoreCache[k] = null; });
}

// Activa la persistencia offline UNA sola vez por sesión: las escrituras que
// no puedan llegar a Firestore se guardan localmente y se reenvían solas
// cuando vuelva la conexión (evita perder un registro por un cortón de red).
let persistenceEnabled = false;
async function enableOfflinePersistence(fs){
  if(persistenceEnabled || !fs) return;
  persistenceEnabled = true;
  try{
    await fs.enablePersistence({ synchronizeTabs: true });
  }catch(err){
    if(err && err.code !== 'failed-precondition' && err.code !== 'unimplemented'){
      console.warn('Persistencia offline no disponible', err);
    }
  }
}



/* -------------------------------------------------------------------------
   2. UTILIDADES
   ------------------------------------------------------------------------- */

function uid(kind){
  kind = kind || 'producto';
  db.contador[kind] = db.contador[kind] || 1;
  const n = db.contador[kind]++;
  return kind[0] + n + '_' + Date.now().toString(36);
}

function escapeHtml(str){
  if(str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function fmtMoney(n){
  n = Number(n) || 0;
  return 'Bs ' + n.toFixed(2);
}

function normalize(str){
  return String(str||'').toUpperCase().trim();
}

function todayISO(){
  return new Date().toISOString();
}

/* -------------------------------------------------------------------------
   2b. IMÁGENES DE PRODUCTOS (LOCALES — IndexedDB, NO van a Firebase)
   -------------------------------------------------------------------------
   Cada imagen se guarda SOLO en este dispositivo (IndexedDB), separada de la
   base de datos que se sincroniza a Firebase. Así los ~1300 productos pueden
   tener foto sin ocupar espacio en la nube. La imagen queda ligada al id del
   producto y solo la ve este dispositivo.
   ------------------------------------------------------------------------- */
const IMG_DB_NAME = 'stockferre_imagenes_v1';
let imgDB = null;
let imgCache = {}; // productId -> arreglo de dataURLs, del modo actual
let imgUrlCache = {}; // productId -> arreglo con la URL original de cada foto (si vino de un link)

function imgStoreName(modo){
  return 'imgs_' + (modo || currentModo);
}

function openImgDB(){
  return new Promise((resolve, reject)=>{
    if(imgDB){ resolve(imgDB); return; }
    if(typeof indexedDB === 'undefined'){ reject(new Error('IndexedDB no disponible')); return; }
    const req = indexedDB.open(IMG_DB_NAME, 1);
    req.onupgradeneeded = (e)=>{
      const db = e.target.result;
      if(!db.objectStoreNames.contains('imgs_manual')) db.createObjectStore('imgs_manual');
      if(!db.objectStoreNames.contains('imgs_electrico')) db.createObjectStore('imgs_electrico');
    };
    req.onsuccess = ()=>{ imgDB = req.result; resolve(imgDB); };
    req.onerror = ()=> reject(req.error || new Error('IndexedDB error'));
  });
}

// Devuelve la PRIMERA foto del producto (la que se ve en la tabla y detalles).
function getImage(productId){
  const arr = productId ? (imgCache[productId] || []) : [];
  return Array.isArray(arr) && arr.length ? arr[0] : '';
}

const MAX_IMGS = 3;

// Devuelve TODAS las fotos del producto (para el carrusel).
function getImages(productId){
  const arr = productId ? (imgCache[productId] || []) : [];
  return Array.isArray(arr) ? arr.slice() : [];
}

function getImageCount(productId){
  return productId ? getImages(productId).length : 0;
}

// Devuelve el LINK original con que se cargó la primera foto (si vino de una URL).
// Se usa para exportarlo en la columna IMAGEN y tener un respaldo del origen.
function getImageUrl(productId){
  const arr = productId ? (imgUrlCache[productId] || []) : [];
  return Array.isArray(arr) && arr.length ? (arr[0] || '') : '';
}

/* -------------------------------------------------------------------------
   MINIATURAS PEREZOSAS: las filas que están fuera de pantalla NO decodifican
   su foto de golpe; se pintan con un marcador y la foto se muestra recién
   cuando el usuario se acerca (IntersectionObserver). Así una lista larga de
   productos con foto carga mucho más rápido.
   ------------------------------------------------------------------------- */
const IMG_LAZY_FIRST = 25; // filas iniciales que sí se pintan de inmediato
let imgLazyObserver = null;
let imgLazyObserved = new Set();

function getImgLazyObserver(){
  if(imgLazyObserver) return imgLazyObserver;
  if(typeof IntersectionObserver === 'undefined') return null;
  imgLazyObserver = new IntersectionObserver(entries=>{
    for(const entry of entries){
      if(entry.isIntersecting) hydrateLazyThumb(entry.target);
    }
  }, { rootMargin: '300px' });
  return imgLazyObserver;
}

function hydrateLazyThumb(el){
  if(!el || el.dataset.loaded) return;
  el.dataset.loaded = '1';
  const pid = el.dataset.lazyImg;
  const obs = getImgLazyObserver();
  if(obs) obs.unobserve(el);
  imgLazyObserved.delete(el);
  const img = pid ? getImage(pid) : '';
  if(img){
    el.innerHTML = `<img src="${img}" class="prod-thumb" alt="" data-img-product="${pid}" decoding="async">`;
  }
}

function armImgLazyLoader(scope){
  const obs = getImgLazyObserver();
  if(!obs || !scope) return;
  scope.querySelectorAll('.prod-thumb-lazy').forEach(el=>{
    if(imgLazyObserved.has(el)) return;
    imgLazyObserved.add(el);
    obs.observe(el);
  });
}

function resetImgLazy(){
  if(imgLazyObserver){
    imgLazyObserved.forEach(el=> imgLazyObserver.unobserve(el));
    imgLazyObserved = new Set();
  }
}

function loadImagesFromStore(modo){
  return openImgDB().then(db => new Promise(resolve=>{
    const storeName = imgStoreName(modo);
    if(!db.objectStoreNames.contains(storeName)){ resolve(imgCache); return; }
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = ()=>{
      (req.result || []).forEach(item => {
        if(item && item.id){
          // Normaliza a arreglos. Las imágenes guardadas con la versión vieja
          // de la app eran UNA sola cadena: se convierten a un arreglo de 1.
          const dataArr = Array.isArray(item.data) ? item.data : (item.data ? [item.data] : []);
          let urlArr = Array.isArray(item.url) ? item.url : (item.url ? [item.url] : []);
          // Imágenes viejas guardadas como URL directa (sin dataURL): recupera el link.
          if(dataArr.length === 1 && !urlArr[0] && /^https?:\/\//i.test(String(dataArr[0]))) urlArr = [dataArr[0]];
          imgCache[item.id] = dataArr;
          imgUrlCache[item.id] = urlArr;
        }
      });
      resolve(imgCache);
    };
    req.onerror = ()=> resolve(imgCache);
  })).catch(err=>{ console.error('Error leyendo imágenes', err); imgCache = {}; imgUrlCache = {}; return imgCache; });
}

// Carga las imágenes del modo indicado. En modo invitado mezcla ambos modos
// (Manuales + Eléctricas) porque el invitado ve productos de los dos.
function loadImagesForModo(modo){
  const m = modo || currentModo;
  imgCache = {};
  imgUrlCache = {};
  if(m === 'invitado'){
    return Promise.all([loadImagesFromStore('manual'), loadImagesFromStore('electrico')])
      .then(()=> imgCache);
  }
  return loadImagesFromStore(m);
}

// AÑADE una foto más al producto (un producto puede tener varias). Lee primero
// las fotos que YA estaban guardadas en IndexedDB (no confía en la caché), así
// nunca se pierden ni se pisan las fotos existentes al añadir una nueva.
function saveImageLocal(productId, data, url){
  if(!productId || !data) return Promise.resolve(false);
  return openImgDB().then(db => new Promise(resolve=>{
    const store = imgStoreName();
    if(!db.objectStoreNames.contains(store)){
      console.error('Tienda de imágenes no existe: ' + store);
      resolve(false);
      return;
    }
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    const getReq = os.get(productId);
    getReq.onsuccess = ()=>{
      const prev = getReq.result || null;
      const dataArr = prev && Array.isArray(prev.data) ? prev.data.slice()
                     : (prev && prev.data ? [prev.data] : []);
      const urlArr = prev && Array.isArray(prev.url) ? prev.url.slice()
                     : (prev && prev.url ? [prev.url] : []);
      if(dataArr.length >= MAX_IMGS){ resolve(false); return; }
      dataArr.push(data);
      urlArr.push(url || '');
      os.put({ id: productId, data: dataArr, url: urlArr }, productId);
      tx.oncomplete = ()=>{ imgCache[productId] = dataArr; imgUrlCache[productId] = urlArr; resolve(true); };
      tx.onerror = ()=>{ console.error('Error guardando imagen', tx.error); resolve(false); };
    };
    getReq.onerror = ()=>{ console.error('Error leyendo imagen', getReq.error); resolve(false); };
  })).catch(err=>{ console.error('Error guardando imagen', err); return false; });
}

// REEMPLAZA todas las fotos del producto por un arreglo (se usa al restaurar
// un backup, que trae todas las fotos juntas). Si el arreglo está vacío borra.
function saveImagesLocal(productId, dataArr, urlArr){
  if(!productId) return Promise.resolve(false);
  dataArr = (Array.isArray(dataArr) ? dataArr : (dataArr ? [dataArr] : [])).filter(Boolean).slice(0, MAX_IMGS);
  urlArr = Array.isArray(urlArr) ? urlArr : (urlArr ? [urlArr] : []);
  urlArr = urlArr.slice(0, dataArr.length);
  return openImgDB().then(db => new Promise(resolve=>{
    const store = imgStoreName();
    const tx = db.transaction(store, 'readwrite');
    if(dataArr.length === 0) tx.objectStore(store).delete(productId);
    else tx.objectStore(store).put({ id: productId, data: dataArr, url: urlArr }, productId);
    tx.oncomplete = ()=>{
      if(dataArr.length === 0){ delete imgCache[productId]; delete imgUrlCache[productId]; }
      else{ imgCache[productId] = dataArr.slice(); imgUrlCache[productId] = urlArr.slice(); }
      resolve(true);
    };
    tx.onerror = ()=>{ console.error('Error guardando imágenes', tx.error); resolve(false); };
  })).catch(err=>{ console.error('Error guardando imágenes', err); return false; });
}

// Quita UNA foto del producto (por su posición dentro del arreglo).
function removeImageAtLocal(productId, index){
  return openImgDB().then(db => new Promise(resolve=>{
    const store = imgStoreName();
    if(!db.objectStoreNames.contains(store)){
      console.error('Tienda de imágenes no existe: ' + store);
      resolve(false);
      return;
    }
    const tx = db.transaction(store, 'readwrite');
    const os = tx.objectStore(store);
    const getReq = os.get(productId);
    getReq.onsuccess = ()=>{
      const prev = getReq.result || null;
      const dataArr = prev && Array.isArray(prev.data) ? prev.data.slice()
                     : (prev && prev.data ? [prev.data] : []);
      const urlArr = prev && Array.isArray(prev.url) ? prev.url.slice()
                     : (prev && prev.url ? [prev.url] : []);
      dataArr.splice(index, 1);
      urlArr.splice(index, 1);
      if(dataArr.length === 0) os.delete(productId);
      else os.put({ id: productId, data: dataArr, url: urlArr }, productId);
      tx.oncomplete = ()=>{
        if(dataArr.length === 0){ delete imgCache[productId]; delete imgUrlCache[productId]; }
        else{ imgCache[productId] = dataArr; imgUrlCache[productId] = urlArr; }
        resolve(true);
      };
      tx.onerror = ()=>{ console.error('Error borrando imagen', tx.error); resolve(false); };
    };
    getReq.onerror = ()=>{ console.error('Error leyendo imagen', getReq.error); resolve(false); };
  })).catch(err=>{ console.error('Error borrando imagen', err); return false; });
}

// Quita TODAS las fotos del producto (se usa al borrar el producto).
function removeImageLocal(productId){
  if(!productId) return Promise.resolve(false);
  return openImgDB().then(db => new Promise(resolve=>{
    const store = imgStoreName();
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(productId);
    tx.oncomplete = ()=>{ delete imgCache[productId]; delete imgUrlCache[productId]; resolve(true); };
    tx.onerror = ()=>{ console.error('Error borrando imagen', tx.error); resolve(false); };
  })).catch(err=>{ console.error('Error borrando imagen', err); return false; });
}

// Borra TODAS las imágenes de ambos modos (se usa en "Borrar todos los datos").
function clearAllImages(){
  return openImgDB().then(db => new Promise(resolve=>{
    const tx = db.transaction(['imgs_manual','imgs_electrico'], 'readwrite');
    tx.objectStore('imgs_manual').clear();
    tx.objectStore('imgs_electrico').clear();
    tx.oncomplete = ()=>{ imgCache = {}; imgUrlCache = {}; resolve(true); };
    tx.onerror = ()=> resolve(false);
  })).catch(err=>{ console.error('Error limpiando imágenes', err); return false; });
}

// Reduce UNA imagen ya cargada (dataURL) a un tamaño razonable (máx. 400px)
// y la convierte a JPEG de buena calidad: ocupa poco en el dispositivo y es
// lo que sale en el CSV. Las imágenes pegadas por URL también pasan por aquí
// (si no, se guardarían en tamaño original y podrían pesar varios MB cada una).
function compressDataURL(dataUrl){
  return new Promise((resolve, reject)=>{
    const img = new Image();
    img.onload = ()=>{
      const MAX = 400;
      let w = img.width || MAX;
      let h = img.height || MAX;
      if(w > MAX || h > MAX){
        const ratio = Math.min(MAX / w, MAX / h);
        w = Math.round(w * ratio);
        h = Math.round(h * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      try{
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      }catch(err){
        console.warn('No se pudo comprimir, se usará la imagen original', err);
        resolve(dataUrl); // fallback: la imagen original
      }
    };
    img.onerror = ()=> reject(new Error('No se pudo leer la imagen'));
    img.src = dataUrl;
  });
}

function compressImage(file){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = ()=>{
      compressDataURL(reader.result).then(resolve, reject);
    };
    reader.onerror = ()=> reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// Descarga una imagen desde una URL y la convierte a dataURL local.
// POR QUÉ ALGUNAS URLS FUNCIONAN Y OTRAS NO: fetch() necesita que el sitio de
// la imagen envíe la cabecera CORS ("Access-Control-Allow-Origin"). Google,
// Facebook, Pinterest y muchos otros la bloquean, así que el fetch directo
// falla con error de CORS. Para esos casos se reintenta a través de servidores
// proxy con CORS abierto (allorigins, weserv y corsproxy). También se valida
// que la respuesta sea realmente una imagen, no una página HTML de error.
function fetchImageAsDataURL(url){
  url = String(url||'').trim();
  if(!url) return Promise.reject(new Error('La URL está vacía'));
  // Ya es una imagen local (dataURL): se usa tal cual, sin descargarla.
  if(url.startsWith('data:image/')) return Promise.resolve(url);
  if(!/^https?:\/\//i.test(url)){
    return Promise.reject(new Error('La URL debe empezar con http:// o https://'));
  }

  const blobToDataURL = (blob) => new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = ()=> resolve(reader.result);
    reader.onerror = ()=> reject(reader.error);
    reader.readAsDataURL(blob);
  });

  // Confirma que el contenido sea una imagen de verdad cargándola en un <img>.
  // Algunos servidores mandan la foto con tipo "application/octet-stream"
  // (por eso revisar solo el tipo MIME descartaba imágenes válidas), y una
  // página HTML de error jamás cargará como imagen.
  const validarImagen = (dataUrl) => new Promise((resolve, reject)=>{
    const img = new Image();
    img.onload = ()=> resolve(dataUrl);
    img.onerror = ()=> reject(new Error('El link no apunta directamente a una imagen'));
    img.src = dataUrl;
  });

  // Límite de 20s por intento: si un servidor se cuelga o tarda mucho, se
  // descarta ese intento en vez de esperar indefinidamente.
  const conTimeout = (promise, ms) => Promise.race([
    promise,
    new Promise((_, reject)=> setTimeout(()=> reject(new Error('Tiempo de espera agotado')), ms))
  ]);

  const descargar = (fullUrl) =>
    conTimeout(
      fetch(fullUrl, { mode: 'cors', redirect: 'follow' })
        .then(r => { if(!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
        .then(blobToDataURL)
        .then(validarImagen),
      20000
    );

  // Se prueban TODAS las vías a la vez (la URL original + 3 proxies) y se usa
  // la primera que funcione. Antes se probaban una detrás de otra, así que
  // cada intento lento sumaba su espera al siguiente; en paralelo la demora
  // es la de una sola descarga.
  const proxied = [
    'https://api.allorigins.win/raw?url=' + encodeURIComponent(url),
    'https://images.weserv.nl/?url=' + encodeURIComponent(url.replace(/^https?:\/\//i, '')),
    'https://corsproxy.io/?url=' + encodeURIComponent(url)
  ];
  return primeraExito([url, ...proxied].map(descargar)).catch(()=>{
    throw new Error('El sitio no permite compartir la imagen. Descárgala y súbela con "📁 Del dispositivo".');
  });
}

// Resuelve con el primer resultado exitoso de la lista de promesas y solo
// falla cuando TODAS fallaron (equivale a Promise.any, sin depender de que el
// navegador lo soporte).
function primeraExito(promises){
  return new Promise((resolve, reject)=>{
    let pendientes = promises.length;
    let ultimoError = null;
    promises.forEach(p=>{
      Promise.resolve(p).then(resolve, err=>{
        ultimoError = err;
        pendientes--;
        if(pendientes === 0) reject(ultimoError || new Error('fallo'));
      });
    });
  });
}

/* -------------------------------------------------------------------------
   3. PRODUCTOS — CRUD
   ------------------------------------------------------------------------- */

// Busca por código interno O por código de barras (para que escanear un
// código de barras real también encuentre el producto)
function getProductoByCodigo(codigo){
  const c = normalize(codigo);
  if(!c) return null;
  return db.productos.find(p => normalize(p.codigo) === c || (p.codigoBarras && normalize(p.codigoBarras) === c)) || null;
}

function getProductoById(id){
  return db.productos.find(p => p.id === id) || null;
}

function upsertCategoria(nombre){
  const n = String(nombre||'').trim();
  if(!n) return;
  const exists = db.categorias.some(c => normalize(c) === normalize(n));
  if(!exists) db.categorias.push(n);
}

function saveProducto(data){
  upsertCategoria(data.categoria);

  if(data.id){
    const p = getProductoById(data.id);
    if(!p) return null;
    p.codigo = data.codigo.trim();
    p.nombre = data.nombre.trim();
    p.marca = data.marca.trim();
    p.categoria = data.categoria.trim();
    p.codigoBarras = (data.codigoBarras||'').trim();
    p.precioCompra = parseFloat(data.precioCompra) || 0;
    p.precioMarca = parseFloat(data.precioMarca) || 0;
    p.precioVenta = parseFloat(data.precioVenta) || 0;
    touchProducto(p);
    saveDB();
    syncProductoDoc(p); // mantiene el documento del producto en la nube al día
    return p;
  }else{
    // Si ya existe un producto con ese código, actualízalo en vez de duplicar
    const existing = getProductoByCodigo(data.codigo);
    if(existing){
      existing.nombre = data.nombre.trim();
      existing.marca = data.marca.trim();
      existing.categoria = data.categoria.trim();
      existing.codigoBarras = (data.codigoBarras||'').trim() || existing.codigoBarras;
      existing.precioCompra = parseFloat(data.precioCompra) || 0;
      existing.precioMarca = parseFloat(data.precioMarca) || 0;
      existing.precioVenta = parseFloat(data.precioVenta) || 0;
      touchProducto(existing);
      saveDB();
      syncProductoDoc(existing);
      return existing;
    }
    const p = {
      id: uid(),
      codigo: data.codigo.trim(),
      nombre: data.nombre.trim(),
      marca: data.marca.trim(),
      categoria: data.categoria.trim(),
      codigoBarras: (data.codigoBarras||'').trim(),
      precioCompra: parseFloat(data.precioCompra) || 0,
      precioMarca: parseFloat(data.precioMarca) || 0,
      precioVenta: parseFloat(data.precioVenta) || 0,
      caracteristicas: '',
      stock: 0,
      fechaCreacion: todayISO(),
      _updatedAt: Date.now()
    };
    db.productos.push(p);
    saveDB();
    syncProductoDoc(p);
    return p;
  }
}

function deleteProducto(id){
  confirmDialog('Eliminar producto', '¿Seguro que quieres eliminar este producto? Esta acción no se puede deshacer.', ()=>{
    const p = getProductoById(id);
    db.productos = db.productos.filter(x => x.id !== id);
    saveDB();
    removeImageLocal(id); // también quita su imagen local
    if(p) deleteProductoDoc(p); // también lo quita de la nube
    renderProductos();
    renderCategorias();
    toast('Producto eliminado', 'success');
  });
}

/* -------------------------------------------------------------------------
   4b. VENTAS
   ------------------------------------------------------------------------- */

function saveVenta(data){
  const cantidad = parseFloat(data.cantidad) || 0;
  const total = parseFloat(data.total) || 0;
  const precioUnitario = cantidad > 0 ? total / cantidad : 0;
  const venta = {
    id: uid('venta'),
    codigo: data.codigo,
    nombre: data.nombre,
    cantidad,
    precioUnitario,
    total,
    metodoPago: data.metodoPago,
    qrPersona: data.qrPersona || '',
    efectivoMonto: parseFloat(data.efectivoMonto) || 0,
    qrMonto: parseFloat(data.qrMonto) || 0,
    fecha: todayISO()
  };

  // En modo invitado la venta se guarda en la base del modo al que pertenece
  // el producto (Manuales o Eléctricas), no en una base de invitado.
  if(currentModo === 'invitado'){
    guestCommitVenta(venta, data, cantidad);
    return venta;
  }

  db.ventas.unshift(venta);

  // El dinero recibido por la venta (efectivo o QR) se suma al efectivo actual
  db.finanzas = db.finanzas || {};
  db.finanzas.caja = (Number(db.finanzas.caja) || 0) + total;

  // Descuenta del stock del producto (si es un producto real, no "OTRO").
  // Se permite que el stock quede en 0 o negativo: la venta nunca se bloquea.
  const p = getProductoByCodigo(data.codigo);
  if(p){
    p.stock = (p.stock || 0) - cantidad;
    touchProducto(p);
    applyStockDelta(p, -cantidad); // descuenta también en la nube, de forma atómica
  }

  saveDB();
  return venta;
}

// El invitado vende productos de ambos modos: la venta se escribe en la base
// del modo destino (por defecto, el modo del producto; para "OTRO" lo elige
// el vendedor) y se descuenta el stock de esa base.
function guestCommitVenta(venta, data, cantidad){
  const modo = data.modoDestino || 'manual';
  const dbObj = loadModoDB(modo);
  const p = findProductoInDB(dbObj, data.codigo);
  if(p){
    p.stock = (p.stock || 0) - cantidad;
    touchProducto(p);
    applyStockDelta(p, -cantidad, modo); // descuenta también en la nube del modo
  }
  dbObj.contador = dbObj.contador || { producto: 1, venta: 1 };
  dbObj.contador.venta = dbObj.contador.venta || 1;
  const n = dbObj.contador.venta++;
  dbObj.ventas.unshift({ ...venta, id: 'v' + n + '_' + Date.now().toString(36) });
  // El dinero de la venta se suma al efectivo del modo al que pertenece
  dbObj.finanzas = dbObj.finanzas || {};
  dbObj.finanzas.caja = (Number(dbObj.finanzas.caja) || 0) + (venta.total || 0);
  persistModoDB(modo, dbObj);
  // Reconstruye la vista combinada para que la venta aparezca al instante
  db = buildGuestDB();
  renderVentas();
  renderProductos();
}

// Borra UNA venta. Antes de borrar se pregunta si se mantiene el inventario:
//   mantenerInventario = true  → el stock NO se toca (solo sale la venta).
//   mantenerInventario = false → la cantidad se devuelve al stock del producto.
function deleteVenta(id, mantenerInventario){
  // El invitado elimina desde la base del modo al que pertenece la venta.
  let dbObj = db;
  let modo = currentModo;
  if(currentModo === 'invitado'){
    const m = loadModoDB('manual');
    const e = loadModoDB('electrico');
    const enM = m.ventas.some(v => v.id === id);
    const enE = e.ventas.some(v => v.id === id);
    dbObj = enM ? m : (enE ? e : null);
    modo = enM ? 'manual' : 'electrico';
  }
  if(!dbObj) return;
  const venta = dbObj.ventas.find(v => v.id === id);
  if(!venta) return;
  if(!mantenerInventario){
    const p = findProductoInDB(dbObj, venta.codigo);
    if(p){
      p.stock = (p.stock || 0) + venta.cantidad;
      touchProducto(p);
      applyStockDelta(p, venta.cantidad, modo); // devuelve la cantidad a la nube
    }
  }
  dbObj.ventas = dbObj.ventas.filter(v => v.id !== id);
  // Al eliminar una venta, el dinero que se recibió sale del efectivo actual
  dbObj.finanzas = dbObj.finanzas || {};
  dbObj.finanzas.caja = (Number(dbObj.finanzas.caja) || 0) - (venta.total || 0);
  if(currentModo === 'invitado'){
    persistModoDB(modo, dbObj);
    db = buildGuestDB();
  }else{
    saveDB();
  }
  renderVentas();
  renderInventario();
  renderProductos();
  renderFinanzas();
  toast('Venta eliminada', 'success');
}

// Vacía TODO el historial de ventas (solo dueño en Manuales y Eléctricas).
// Pregunta lo mismo que al borrar una: si mantener inventario.
function vaciarHistorialVentas(){
  ventaBorrarDialog('Vaciar historial de ventas', '¿Vaciar todo el historial de ventas?\n\n¿Mantener el inventario?\n• Sí = el inventario NO se modifica.\n• No = las cantidades vuelven al stock.',
    ()=> vaciarVentasConStock(false),
    ()=> vaciarVentasConStock(true));
}
function vaciarVentasConStock(restaurarStock){
  if(restaurarStock){
    db.ventas.forEach(v => {
      const p = getProductoByCodigo(v.codigo);
      if(p){
        p.stock = (p.stock || 0) + v.cantidad;
        touchProducto(p);
        applyStockDelta(p, v.cantidad); // devuelve la cantidad a la nube
      }
    });
  }
  db.ventas = [];
  saveDB();
  renderVentas();
  renderInventario();
  renderProductos();
  toast('Historial de ventas vaciado', 'success');
}

// Recalcula y muestra el Precio Unitario = Precio Total / Cantidad
// cada vez que el usuario cambia alguno de esos dos campos.
function recalcVentaPrecioUnitario(){
  const cantidad = parseFloat(document.getElementById('vCantidad').value);
  const total = parseFloat(document.getElementById('vPrecioTotal').value);
  const unitarioEl = document.getElementById('vPrecioUnitario');
  if(cantidad > 0 && !isNaN(total)){
    unitarioEl.value = fmtMoney(total / cantidad);
  }else{
    unitarioEl.value = '';
  }
}

// En modo invitado muestra de dónde sale el producto y hacia qué base va la
// venta. Para productos reales queda fijo (según el modo del producto); para
// "OTRO" el vendedor elige. Para el dueño no se muestra nada.
function updateVentaDestinoUI(modo, locked){
  const label = document.getElementById('vModoDestinoLabel');
  const sel = document.getElementById('vModoDestino');
  if(!label || !sel) return;
  if(currentModo !== 'invitado'){ label.style.display = 'none'; return; }
  label.style.display = '';
  sel.value = modo;
  sel.disabled = !!locked;
}

// Vuelve el modal de venta a su modo normal ("Registrar venta") y olvida la
// venta que se estaba editando.
function resetVentaEditUI(){
  editingVentaId = null;
  editingVentaModo = null;
  const title = document.querySelector('#modalVenta .modal-header h3');
  if(title) title.textContent = '💰 Registrar venta';
  const btn = document.querySelector('#formVenta button[type="submit"]');
  if(btn) btn.textContent = 'Registrar venta';
}

// Edición de ventas: el invitado (y el dueño) pueden corregir una venta ya
// registrada. Se llena el mismo formulario con los datos y al guardar se
// actualiza la venta, el stock y el efectivo del modo al que pertenece.
function openVentaEditModal(id){
  let v = null;
  let modo = currentModo;
  if(currentModo === 'invitado'){
    // El invitado ve las ventas de ambos modos: busca a cuál pertenece.
    const m = loadModoDB('manual');
    const e = loadModoDB('electrico');
    v = m.ventas.find(x => x.id === id) || e.ventas.find(x => x.id === id);
    modo = m.ventas.some(x => x.id === id) ? 'manual' : 'electrico';
  }else{
    v = db.ventas.find(x => x.id === id);
  }
  if(!v){
    toast('No se encontró la venta', 'error');
    return;
  }
  editingVentaId = v.id;
  editingVentaModo = modo;
  const title = document.querySelector('#modalVenta .modal-header h3');
  if(title) title.textContent = '✏️ Editar venta';
  const btn = document.querySelector('#formVenta button[type="submit"]');
  if(btn) btn.textContent = 'Guardar cambios';

  const esOtro = v.codigo === 'OTRO';
  document.getElementById('vEsOtro').value = esOtro ? '1' : '0';
  document.getElementById('vNombreDisplayBox').style.display = esOtro ? 'none' : '';
  document.getElementById('vNombreOtroLabel').style.display = esOtro ? '' : 'none';
  document.getElementById('vCodigo').value = v.codigo || '';
  document.getElementById('vNombre').value = v.nombre || '';
  document.getElementById('vNombreDisplay').textContent = v.nombre || v.codigo || '';
  document.getElementById('vNombreOtroInput').value = v.nombre || '';
  document.getElementById('vCantidad').value = v.cantidad;
  document.getElementById('vPrecioTotal').value = v.total;

  // Método de pago y pago mixto.
  const metodo = v.metodoPago || 'efectivo';
  document.getElementById('vMetodoPago').value = metodo;
  document.querySelectorAll('[data-payment-method]').forEach(b=>{
    b.classList.toggle('active', b.dataset.paymentMethod === metodo);
  });
  const splitBox = document.getElementById('vSplitPago');
  if(splitBox){
    splitBox.style.display = metodo === 'mixto' ? '' : 'none';
    document.getElementById('vEfectivoMonto').value = v.efectivoMonto || 0;
    document.getElementById('vQrMonto').value = v.qrMonto || 0;
  }
  // Quién cobró por QR.
  document.getElementById('vQrPersona').value = v.qrPersona || '';
  updateQrTabLabel(document.querySelector('[data-payment-method="qr"]'));
  // Modo destino: en el invitado queda fijo (la venta no cambia de base).
  updateVentaDestinoUI(modo, true);
  recalcVentaPrecioUnitario();
  openModal('modalVenta');
}

// Actualiza una venta existente (cantidad, total, pago) y ajusta el stock y el
// efectivo del modo al que pertenece. Funciona igual para el dueño y para el
// invitado (que guarda en la base del modo de la venta).
function updateVenta(id, modo, data){
  const cantidad = parseFloat(data.cantidad) || 0;
  const total = parseFloat(data.total) || 0;
  const precioUnitario = cantidad > 0 ? total / cantidad : 0;
  const applyStockDeltaModo = currentModo === 'invitado' ? modo : currentModo;
  const dbObj = currentModo === 'invitado' ? loadModoDB(modo) : db;
  // Se guarda el MISMO objeto que se modificó (en invitado no volver a leer
  // de LocalStorage, o se perdería la edición).
  const persist = () => currentModo === 'invitado' ? persistModoDB(modo, dbObj) : saveDB();

  const v = dbObj.ventas.find(x => x.id === id);
  if(!v) return false;

  const oldCantidad = v.cantidad || 0;
  const oldTotal = v.total || 0;
  const deltaCant = oldCantidad - cantidad;

  // Ajusta el stock: devuelve la cantidad que se vendió antes y descuenta la
  // nueva (para "OTRO" no hay producto ni stock).
  if(v.codigo !== 'OTRO'){
    const p = findProductoInDB(dbObj, v.codigo) || getProductoByCodigo(v.codigo);
    if(p){
      p.stock = (p.stock || 0) + deltaCant;
      touchProducto(p);
      applyStockDelta(p, deltaCant, applyStockDeltaModo);
    }
  }

  // Ajusta el efectivo de la caja: sale lo viejo, entra lo nuevo.
  dbObj.finanzas = dbObj.finanzas || {};
  dbObj.finanzas.caja = (Number(dbObj.finanzas.caja) || 0) + (total - oldTotal);

  // Actualiza los campos editables.
  v.cantidad = cantidad;
  v.precioUnitario = precioUnitario;
  v.total = total;
  v.nombre = data.nombre || v.nombre;
  v.metodoPago = data.metodoPago;
  v.qrPersona = data.qrPersona || '';
  v.efectivoMonto = data.efectivoMonto || 0;
  v.qrMonto = data.qrMonto || 0;

  persist();
  if(currentModo === 'invitado') db = buildGuestDB();
  renderVentas();
  renderInventario();
  renderProductos();
  renderFinanzas();
  return true;
}

function openVentaModal(producto){
  resetVentaEditUI();
  document.getElementById('vEsOtro').value = '0';
  document.getElementById('vNombreDisplayBox').style.display = '';
  document.getElementById('vNombreOtroLabel').style.display = 'none';
  document.getElementById('vCodigo').value = producto.codigo;
  document.getElementById('vNombreDisplay').textContent = producto.nombre;
  document.getElementById('vNombre').value = producto.nombre;
  document.getElementById('vCantidad').value = 1;
  document.getElementById('vPrecioTotal').value = producto.precioVenta || 0;
  document.querySelectorAll('[data-payment-method]').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.paymentMethod === 'efectivo');
  });
  document.getElementById('vMetodoPago').value = 'efectivo';
  const qrTabOpen = document.querySelector('[data-payment-method="qr"]');
  if(qrTabOpen) qrTabOpen.textContent = '📱 QR';
  resetSplitPagoUI();
  updateVentaDestinoUI(producto.modoOrigin || 'manual', true);
  recalcVentaPrecioUnitario();
  openModal('modalVenta');
}

// Venta de un producto que NO está en el inventario: se pide una descripción
// libre y un precio. Se registra en el historial de ventas, pero nunca se
// crea como producto ni afecta ningún stock.
function openVentaModalOtro(){
  resetVentaEditUI();
  document.getElementById('vEsOtro').value = '1';
  document.getElementById('vNombreDisplayBox').style.display = 'none';
  document.getElementById('vNombreOtroLabel').style.display = '';
  document.getElementById('vCodigo').value = '';
  document.getElementById('vNombre').value = '';
  document.getElementById('vNombreOtroInput').value = '';
  document.getElementById('vCantidad').value = 1;
  document.getElementById('vPrecioTotal').value = '';
  document.querySelectorAll('[data-payment-method]').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.paymentMethod === 'efectivo');
  });
  document.getElementById('vMetodoPago').value = 'efectivo';
  const qrTabOpen = document.querySelector('[data-payment-method="qr"]');
  if(qrTabOpen) qrTabOpen.textContent = '📱 QR';
  resetSplitPagoUI();
  updateVentaDestinoUI('manual', false);
  recalcVentaPrecioUnitario();
  openModal('modalVenta');
  setTimeout(()=> document.getElementById('vNombreOtroInput').focus(), 50);
}

// Pago mixto (QR + efectivo): si no hay nada escrito aún, deja por defecto
// todo en efectivo; la otra casilla se rellena sola con el total menos lo
// escrito (lo hace el listener de cada campo).
function syncSplitPago(){
  const box = document.getElementById('vSplitPago');
  if(!box) return;
  const total = parseFloat(document.getElementById('vPrecioTotal').value) || 0;
  const totalEl = document.getElementById('vSplitTotal');
  if(totalEl) totalEl.textContent = fmtMoney(total);
  const ef = document.getElementById('vEfectivoMonto');
  const qr = document.getElementById('vQrMonto');
  const efVal = parseFloat(ef.value);
  const qrVal = parseFloat(qr.value);
  if((isNaN(efVal) && isNaN(qrVal)) || (total > 0 && efVal === 0 && qrVal === 0)){
    ef.value = total.toFixed(2);
    qr.value = '0.00';
  }
}
function resetSplitPagoUI(){
  const box = document.getElementById('vSplitPago');
  if(!box) return;
  box.style.display = 'none';
  document.getElementById('vEfectivoMonto').value = '';
  document.getElementById('vQrMonto').value = '';
}

function handleVentaSubmit(e){
  e.preventDefault();
  const esOtro = document.getElementById('vEsOtro').value === '1';
  const cantidad = parseFloat(document.getElementById('vCantidad').value);
  const total = parseFloat(document.getElementById('vPrecioTotal').value);
  const metodoPago = document.getElementById('vMetodoPago').value;

  if(!cantidad || cantidad <= 0){
    toast('Ingresa una cantidad válida', 'error');
    return;
  }
  if(total === null || isNaN(total) || total < 0){
    toast('Ingresa un precio total válido', 'error');
    return;
  }
  if(!metodoPago){
    toast('Selecciona un método de pago', 'error');
    return;
  }

  let efectivoMonto = 0, qrMonto = 0;
  if(metodoPago === 'mixto'){
    efectivoMonto = parseFloat(document.getElementById('vEfectivoMonto').value) || 0;
    qrMonto = parseFloat(document.getElementById('vQrMonto').value) || 0;
    if(Math.abs((efectivoMonto + qrMonto) - total) > 0.01){
      toast('Efectivo + QR deben sumar el total', 'error');
      return;
    }
  }

  let codigo, nombre;
  if(esOtro){
    nombre = document.getElementById('vNombreOtroInput').value.trim();
    if(!nombre){
      toast('Escribe una descripción para el producto', 'error');
      return;
    }
    codigo = 'OTRO';
  }else{
    codigo = document.getElementById('vCodigo').value;
    nombre = document.getElementById('vNombre').value;
  }

  const modoDestino = document.getElementById('vModoDestino') ? document.getElementById('vModoDestino').value : 'manual';
  const qrPersona = document.getElementById('vQrPersona') ? document.getElementById('vQrPersona').value : '';

  // Si el modal está en modo "editar", actualiza la venta existente (ajusta
  // stock y efectivo) en vez de registrar una nueva.
  if(editingVentaId){
    const ok = updateVenta(editingVentaId, editingVentaModo, { codigo, nombre, cantidad, total, metodoPago, qrPersona, efectivoMonto, qrMonto });
    resetVentaEditUI();
    closeAllModals();
    if(!ok){ toast('No se encontró la venta', 'error'); return; }
    playClickSound();
    toast('Venta actualizada', 'success');
    return;
  }

  const ventaGuardada = saveVenta({ codigo, nombre, cantidad, total, metodoPago, modoDestino, qrPersona, efectivoMonto, qrMonto });
  notifySale(ventaGuardada);
  playCashRegisterSound();
  closeAllModals();
  renderInventario();
  renderProductos();
  toast('Venta registrada', 'success');
}

/* -------------------------------------------------------------------------
   4. VISTA: ESCÁNER / RESULTADO
   ------------------------------------------------------------------------- */

// Baja automáticamente la pantalla hasta la tarjeta con la información del
// producto detectado, para que se vea sin que el usuario tenga que hacer scroll.
function scrollToScanResult(elementId){
  const el = document.getElementById(elementId);
  if(el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderScanResult(codigo){
  renderScanResultInto('scanResult', codigo, 'lookup');
}

// Renderiza la misma tarjeta de resultado (usada en la pestaña "Escanear")
// dentro de cualquier contenedor. En las pestañas Inventario y Compras es
// idéntica, solo que el botón de acción dice "Registrar" y lleva al registro
// de cantidad en vez de abrir la venta.
function renderScanResultInto(elementId, codigo, context){
  const resultDiv = document.getElementById(elementId);
  if(!resultDiv) return;
  const p = getProductoByCodigo(codigo);

  if(!p){
    if(context === 'compra'){
      resultDiv.innerHTML = `
        <div class="scan-not-found">
          ⚠️ No se encontró ningún producto con el código <strong>${escapeHtml(codigo)}</strong>.<br>
          <span style="font-size:12px;">No hay problema: se creará un producto nuevo al registrar la compra.</span>
          <div style="margin-top:10px;">
            <button class="btn btn-primary btn-sm" id="btnCompraCreate_${elementId}">🛒 Registrar ingreso</button>
          </div>
        </div>`;
      const btnCreate = document.getElementById(`btnCompraCreate_${elementId}`);
      if(btnCreate) btnCreate.addEventListener('click', ()=>{
        closeCompraScan();
        openCompraDetalleForm(null, codigo);
      });
      return;
    }
    resultDiv.innerHTML = `
      <div class="scan-not-found">
        ⚠️ No se encontró ningún producto con el código <strong>${escapeHtml(codigo)}</strong>.
        ${currentRole === 'guest' ? '' : `
        <div style="margin-top:10px;">
          <button class="btn btn-primary btn-sm" id="btnCreateFromScan_${elementId}">+ Crear producto con este código</button>
        </div>`}
      </div>`;
    const btnCreate = document.getElementById(`btnCreateFromScan_${elementId}`);
    if(btnCreate) btnCreate.addEventListener('click', ()=>{
      if(context === 'inventario') closeInventarioScan();
      openProductModal(null, codigo);
    });
    return;
  }

  const secondBtnHtml = context === 'inventario'
    ? `<button class="btn btn-primary btn-sm" id="btnActionFromScan_${elementId}">📋 Registrar</button>`
    : context === 'compra'
      ? `<button class="btn btn-primary btn-sm" id="btnActionFromScan_${elementId}">🛒 Registrar ingreso</button>`
      : `<button class="btn btn-success btn-sm" id="btnActionFromScan_${elementId}">💰 Venderlo</button>`;

  // En el contexto de Inventario NO se muestra información de precios: solo
  // descripción, código, código de barras y stock actual.
  const stockRowHtml = `<div class="sr-row"><span>Stock actual</span><strong class="${(p.stock||0) < 0 ? 'stock-negative' : ''}">${p.stock || 0}</strong></div>`;
  const detailRowsHtml = context === 'inventario'
    ? `
      <div class="sr-row"><span>Código de barras</span><strong>${escapeHtml(p.codigoBarras || '-')}</strong></div>
      ${stockRowHtml}`
    : `
      <div class="sr-row"><span>Marca</span><strong>${escapeHtml(p.marca || '-')}</strong></div>
      <div class="sr-row"><span>Categoría</span><strong>${escapeHtml(p.categoria || '-')}</strong></div>
      ${stockRowHtml}
      ${currentRole === 'guest' ? '' : `
      <div class="sr-row"><span>Precio de compra</span><strong>${fmtMoney(p.precioCompra)}</strong></div>
      <div class="sr-row"><span>Precio de marca</span><strong>${fmtMoney(p.precioMarca)}</strong></div>`}
      <div class="sr-row"><span>Precio de venta</span><strong>${fmtMoney(p.precioVenta)}</strong></div>`;

  resultDiv.innerHTML = `
    <div class="scan-result-card">
      <h4>📦 ${escapeHtml(p.nombre)}</h4>
      <div class="sr-row"><span>Código</span><strong>${escapeHtml(p.codigo)}</strong></div>
      ${detailRowsHtml}
      <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap;">
        ${currentRole !== 'guest' && context !== 'compra' ? `<button class="btn btn-secondary btn-sm" id="btnEditFromScan_${elementId}">✏️ Editar producto</button>` : ''}
        ${secondBtnHtml}
      </div>
    </div>`;

  const btnEdit = document.getElementById(`btnEditFromScan_${elementId}`);
  if(btnEdit) btnEdit.addEventListener('click', ()=>{
    // Si venimos del registro de inventario, hay que cerrar el modal del
    // escáner antes de abrir el de edición: como ambos modales comparten
    // z-index, el del escáner (que está después en el DOM) taparía el de
    // editar producto y el clic parecería "no funcionar".
    if(context === 'inventario') closeInventarioScan();
    openProductModal(p);
  });
  document.getElementById(`btnActionFromScan_${elementId}`).addEventListener('click', ()=>{
    if(context === 'inventario'){
      closeInventarioScan();
      openInventarioCantidadBox(p, codigo);
    }else if(context === 'compra'){
      closeCompraScan();
      openCompraDetalleForm(p, codigo);
    }else{
      openVentaModal(p);
    }
  });
}

// scanContext: 'lookup' (pestaña Escanear normal), 'inventario' (registro de
// cantidad desde la pestaña Inventario) o 'compra' (registro de compra desde
// la pestaña Compras) — cambia qué pasa al detectar un código.
let scanContext = 'lookup';

/* -------------------------------------------------------------------------
   4b. SONIDOS DEL ESCÁNER (Web Audio API — sin archivos de audio)
   Un pitido corto y agudo cuando el OCR (numérico/alfanumérico) detecta un
   código, y el "beep-beep" clásico de lector de código de barras cuando lo
   detecta ZXing. Se sintetizan al instante, así que la app sigue funcionando
   sin internet.
   ------------------------------------------------------------------------- */
let audioCtx = null;
function ensureAudioCtx(){
  if(!audioCtx){
    try{ audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }catch(e){}
  }
  if(audioCtx && audioCtx.state === 'suspended'){ try{ audioCtx.resume(); }catch(e){} }
  return audioCtx;
}

// Programa un sonido SOLO cuando el contexto de audio ya está corriendo.
// Sin esto, si el contexto arranca en 'suspended' (política de autoplay de
// los navegadores) y las notas se programan antes de que reanude, se pierden
// y el sonido "no suena". Al esperar a que resume() termine, las notas se
// programan con el reloj ya avanzando y sí se escuchan.
function scheduleOnAudio(fn){
  const ctx = ensureAudioCtx();
  if(!ctx) return;
  const run = ()=>{ try{ fn(ctx); }catch(e){} };
  if(ctx.state === 'suspended'){
    try{
      const p = ctx.resume();
      if(p && p.then) p.then(run).catch(run);
      else setTimeout(run, 80);
    }catch(e){ setTimeout(run, 80); }
  }else{
    run();
  }
}

function playTone(freq, delay, dur, vol, type){
  const ctx = ensureAudioCtx();
  if(!ctx) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type || 'sine';
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol || 0.2, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

// Pitido corto y agudo: código numérico/alfanumérico detectado por el OCR.
function playOcrBeep(){
  playTone(1760, 0, 0.09, 0.16, 'sine');
  playTone(2640, 0.02, 0.06, 0.08, 'sine');
}

// "Beep-beep" clásico de los lectores de código de barras de mano (el sonido
// más común de caja registradora): dos tonos rápidos, el segundo más grave.
function playBarcodeBeep(){
  playTone(2000, 0, 0.10, 0.18, 'square');
  playTone(1400, 0.13, 0.14, 0.18, 'square');
}

// Sonido de activar el modo pro: REVELACIÓN PREMIUM. Base cálida y profunda
// (La mayor add9) que se enciende suavemente, arpegio de campanitas de cristal
// ascendente, destello de brillo y un acorde dorado final largo y elegante.
// Refinado y lujoso, como desbloquear un nivel de oro.
function playProModeSound(){
  scheduleOnAudio(ctx => {
    const now = ctx.currentTime;
    const t0 = now + 0.02;

    // Base cálida profunda: acorde La mayor add9 (A2 E3 A3 C#4 B4) que respira
    const warm = (freq, t, dur, vol) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      o.connect(g);
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.3);
      g.gain.setValueAtTime(vol, t + dur * 0.7);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.start(t);
      o.stop(t + dur + 0.05);
    };
    warm(110.00, t0, 2.1, 0.07);      // A2
    warm(164.81, t0, 2.0, 0.06);      // E3
    warm(220.00, t0, 1.9, 0.05);      // A3
    warm(277.18, t0, 1.8, 0.04);      // C#4
    warm(246.94, t0, 1.7, 0.03);      // B4 (add9)

    // Campanita de cristal: parciales brillantes y ricas
    const bell = (freq, t, dur, vol) => {
      const partials = [1, 2.01, 2.92, 4.03, 5.4];
      const gains = [1, 0.42, 0.26, 0.14, 0.07];
      partials.forEach((mul, i) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = freq * mul;
        o.connect(g);
        g.connect(ctx.destination);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(vol * gains[i], t + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur * (0.5 + i * 0.18));
        o.start(t);
        o.stop(t + dur + 0.1);
      });
    };

    // Arpegio de cristal ascendente y elegante
    const notas = [659.26, 880.00, 1108.73, 1318.51, 1760.00];
    notas.forEach((f, i) => bell(f, t0 + 0.28 + i * 0.07, 1.3, 0.09));

    // Destello de brillo que sube suavemente
    const sh = ctx.createOscillator();
    const sg = ctx.createGain();
    sh.type = 'sine';
    sh.frequency.setValueAtTime(1100, t0 + 0.28);
    sh.frequency.exponentialRampToValueAtTime(3800, t0 + 0.85);
    sg.gain.setValueAtTime(0.0001, t0 + 0.28);
    sg.gain.linearRampToValueAtTime(0.04, t0 + 0.36);
    sg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.95);
    sh.connect(sg);
    sg.connect(ctx.destination);
    sh.start(t0 + 0.28);
    sh.stop(t0 + 1.0);

    // Acorde dorado final: la tríada de cristal sonando junta y desvaneciéndose
    [659.26, 880.00, 1108.73].forEach(f => bell(f, t0 + 0.85, 1.6, 0.10));
    // Centelleo alto de plata al final
    bell(1760.00, t0 + 0.98, 1.2, 0.05);
    bell(2637.02, t0 + 1.05, 1.0, 0.03);
  });
}

// Aplica a cada pestaña exclusiva del modo pro su demora de aparición para
// que salgan UNA POR UNA (la animación y el barrido de brillo viven en CSS,
// usando la variable --reveal-delay). Además, hace que el menú BAJE (se
// desplace) para dejar visible cada pestaña cuando aparece, y si withSound es
// true, programa el campanilleo especial en su momento exacto.
function revealProOnlyItems(withSound){
  const items = document.querySelectorAll('.nav-pro-only');
  const delays = [0.15, 0.35, 0.55];
  items.forEach((el, i) => {
    const d = delays[i] || (0.15 + i * 0.2);
    el.style.setProperty('--reveal-delay', d + 's');
    if(withSound){
      setTimeout(()=> playProRevealSound(i), d * 1000 + 40);
    }
    setTimeout(()=> scrollProMenuToItem(el), (d + 0.35) * 1000);
  });
}

// Desplaza el menú lateral (suavemente) hasta dejar visible la pestaña dada.
function scrollProMenuToItem(el){
  const nav = document.querySelector('.sidebar-nav');
  if(!nav || !el) return;
  const containerTop = nav.getBoundingClientRect().top;
  const elTop = el.getBoundingClientRect().top;
  nav.scrollTo({ top: nav.scrollTop + (elTop - containerTop) - 16, behavior: 'smooth' });
}

// Sonido especial de cada pestaña al revelarse: un "pop" de cristal que sube
// de tono con cada pestaña (La → Do# → Mi → Sol → La'), como pequeñas joyas
// apareciendo una a una.
function playProRevealSound(i){
  scheduleOnAudio(ctx => {
    const t0 = ctx.currentTime + 0.01;
    const freqs = [880.00, 1108.73, 1318.51, 1567.98, 1760.00];
    const f = freqs[i] || 880.00;
    const bell = (freq, t, dur, vol) => {
      const partials = [1, 2.01, 2.92, 4.03];
      const gains = [1, 0.4, 0.22, 0.1];
      partials.forEach((mul, j) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = freq * mul;
        o.connect(g);
        g.connect(ctx.destination);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(vol * gains[j], t + 0.004);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur * (0.5 + j * 0.18));
        o.start(t);
        o.stop(t + dur + 0.1);
      });
    };
    // La nota principal + su octava arriba (centelleo) que aparecen juntas
    bell(f, t0, 0.6, 0.14);
    bell(f * 2, t0 + 0.02, 0.45, 0.06);
    // Pequeño destello agudo que sube rápido (chispita)
    const sp = ctx.createOscillator();
    const sg = ctx.createGain();
    sp.type = 'sine';
    sp.frequency.setValueAtTime(f * 2, t0 + 0.02);
    sp.frequency.exponentialRampToValueAtTime(f * 4, t0 + 0.22);
    sg.gain.setValueAtTime(0.0001, t0 + 0.02);
    sg.gain.linearRampToValueAtTime(0.04, t0 + 0.06);
    sg.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
    sp.connect(sg);
    sg.connect(ctx.destination);
    sp.start(t0 + 0.02);
    sp.stop(t0 + 0.3);
  });
}

function handleScannedCode(codigo, fromCamera){
  codigo = String(codigo).trim();
  if(!codigo) return;
  if(scanContext === 'inventario'){
    handleInventoryScan(codigo);
    if(fromCamera){
      scrollToScanResult('invScanResultBox');
    }
    return;
  }
  if(scanContext === 'compra'){
    // Al detectar el código se cierra el escáner y se abre directo el
    // formulario "Registrar ingreso" (no hay tarjeta de resultado que mostrar).
    handleCompraScan(codigo);
    return;
  }
  if(scanContext === 'venta'){
    // Al detectar el código se cierra el escáner y se abre directo el
    // formulario de registro de venta con ese producto.
    handleVentaScan(codigo);
    return;
  }
  if(scanContext === 'codigobarras'){
    // "Añadir código de barras": el primer código es el del producto y el
    // segundo (código de barras) se guarda en ese producto.
    handleCodigoBarrasScan(codigo, fromCamera);
    return;
  }
  renderScanResult(codigo);
  logScanHistory(codigo);
  if(fromCamera){
    scrollToScanResult('scanResult');
  }
}

const HISTORY_MAX = 300;

function logScanHistory(codigo){
  const p = getProductoByCodigo(codigo);
  db.historialEscaneos.unshift({
    codigo,
    encontrado: !!p,
    nombre: p ? p.nombre : '',
    fecha: todayISO()
  });
  if(db.historialEscaneos.length > HISTORY_MAX){
    db.historialEscaneos.length = HISTORY_MAX;
  }
  saveDB();
}

function logSearchHistory(query){
  query = String(query||'').trim();
  if(!query) return;
  // Evita registrar la misma búsqueda repetida justo seguida
  const last = db.historialBusquedas[0];
  if(last && normalize(last.query) === normalize(query)) return;
  db.historialBusquedas.unshift({ query, fecha: todayISO() });
  if(db.historialBusquedas.length > HISTORY_MAX){
    db.historialBusquedas.length = HISTORY_MAX;
  }
  saveDB();
}

// Registra cada registro de inventario (por escaneo o ajuste manual) con
// fecha y hora. Se guarda solo en LocalStorage de este dispositivo (ver
// saveDB/connectFirebase, que excluyen historialInventario de Firebase).
function logInventarioHistorial(producto, cantidad, tipo){
  db.historialInventario.unshift({
    codigo: producto.codigo,
    nombre: producto.nombre,
    cantidad,
    stockResultante: producto.stock || 0,
    tipo: tipo || 'registro',
    fecha: todayISO()
  });
  if(db.historialInventario.length > HISTORY_MAX){
    db.historialInventario.length = HISTORY_MAX;
  }
}

function fmtHistoryDate(iso){
  try{
    const d = new Date(iso);
    return d.toLocaleString('es-BO', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' });
  }catch(e){ return ''; }
}

// Solo la fecha (día/mes/año), sin hora.
function fmtDateShort(iso){
  try{
    const d = new Date(iso);
    return d.toLocaleDateString('es-BO', { day:'2-digit', month:'2-digit', year:'2-digit' });
  }catch(e){ return ''; }
}

function renderHistorial(){
  const scanBody = document.querySelector('#scanHistoryTable tbody');
  if(db.historialEscaneos.length === 0){
    scanBody.innerHTML = `<tr class="empty-row"><td colspan="4">Todavía no escaneaste ningún código.</td></tr>`;
  }else{
    scanBody.innerHTML = db.historialEscaneos.map(h => `
      <tr>
        <td><strong>${escapeHtml(h.codigo)}</strong></td>
        <td>${h.encontrado ? escapeHtml(h.nombre) : '-'}</td>
        <td>${h.encontrado ? '<span class="badge badge-success-soft">Encontrado</span>' : '<span class="badge badge-danger-soft">No encontrado</span>'}</td>
        <td>${fmtHistoryDate(h.fecha)}</td>
      </tr>
    `).join('');
  }

  const invBody = document.querySelector('#inventarioHistoryTable tbody');
  if(invBody){
    if(db.historialInventario.length === 0){
      invBody.innerHTML = `<tr class="empty-row"><td colspan="6">Todavía no hay registros de inventario.</td></tr>`;
    }else{
      invBody.innerHTML = db.historialInventario.map(h => `
        <tr>
          <td><strong>${escapeHtml(h.codigo)}</strong></td>
          <td>${escapeHtml(h.nombre)}</td>
          <td>${h.cantidad > 0 ? '+' : ''}${h.cantidad}</td>
          <td>${h.stockResultante}</td>
          <td>${escapeHtml(h.tipo)}</td>
          <td>${fmtHistoryDate(h.fecha)}</td>
        </tr>
      `).join('');
    }
  }

  const searchList = document.getElementById('searchHistoryList');
  if(db.historialBusquedas.length === 0){
    searchList.innerHTML = `<p class="hint">Todavía no hiciste ninguna búsqueda en Productos.</p>`;
  }else{
    searchList.innerHTML = db.historialBusquedas.map(h => `
      <div class="history-search-row">
        <span>🔍 ${escapeHtml(h.query)}</span>
        <small>${fmtHistoryDate(h.fecha)}</small>
      </div>
    `).join('');
  }
}

const PAYMENT_LABELS = { efectivo: '💵 Efectivo', qr: '📱 QR', mixto: '💵📱 QR y Efectivo' };

// Personas que cobran por QR. Se eligen al registrar una venta con QR y se
// usan en el "Ajuste de cuentas" para separar lo cobrado por cada uno.
const QR_PERSONAS = ['Abner', 'José', 'Jona', 'Richard'];

// Muestra en el botón QR quién cobra, p. ej. "📱 QR de ABNER".
function updateQrTabLabel(qrTab){
  if(!qrTab) return;
  const sel = document.getElementById('vQrPersona');
  qrTab.textContent = '📱 QR de ' + (sel ? (sel.value || '') : '').toUpperCase();
}

// Abre el recuadro "QR de" para elegir quién cobra. Se abre CADA vez que se
// pulsa el botón QR (aunque ya diga "QR de ABNER") para poder cambiarlo.
function openQrPersonaPicker(){
  const container = document.getElementById('qrPersonaOptions');
  if(!container) return;
  const actual = document.getElementById('vQrPersona').value;
  container.innerHTML = QR_PERSONAS.map(p =>
    `<button type="button" class="btn btn-secondary qr-persona-option${p === actual ? ' active' : ''}" data-qr-persona="${escapeHtml(p)}" style="width:100%; margin-bottom:8px;">${escapeHtml(p)}</button>`
  ).join('');
  openModal('modalQrPersona');
}

// Filtro de la vista Ventas: por defecto solo muestra las ventas de HOY.
// 'hoy' | 'ayer' | 'anteayer' | 'todas' | 'YYYY-MM-DD'
let ventaDateFilter = 'hoy';

function localDateKey(d){
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function ventaFechaKey(iso){
  try{ return localDateKey(new Date(iso)); }catch(e){ return ''; }
}
function dateKeyOffset(days){
  const d = new Date();
  d.setDate(d.getDate() - days);
  return localDateKey(d);
}
function ventasFiltradas(){
  return db.ventas.filter(v => {
    const k = ventaFechaKey(v.fecha);
    if(ventaDateFilter === 'todas') return true;
    if(ventaDateFilter === 'hoy') return k === dateKeyOffset(0);
    if(ventaDateFilter === 'ayer') return k === dateKeyOffset(1);
    if(ventaDateFilter === 'anteayer') return k === dateKeyOffset(2);
    if(/^\d{4}-\d{2}-\d{2}$/.test(ventaDateFilter)) return k === ventaDateFilter;
    return true;
  });
}

// La fecha (YYYY-MM-DD) que se está viendo en la ventana de Ventas, o null si
// el filtro está en "Todas". Sirve para que gastos/préstamos y el ajuste de
// cuentas (CAMBIO incluido) se guarden y muestren POR DÍA, igual que las ventas.
function ventaFilterDateKey(){
  if(/^\d{4}-\d{2}-\d{2}$/.test(ventaDateFilter)) return ventaDateFilter;
  if(ventaDateFilter === 'hoy') return dateKeyOffset(0);
  if(ventaDateFilter === 'ayer') return dateKeyOffset(1);
  if(ventaDateFilter === 'anteayer') return dateKeyOffset(2);
  return null; // 'todas'
}
function ventasFilterLabel(){
  const map = { hoy: 'de hoy', ayer: 'de ayer', anteayer: 'de anteayer', todas: 'de todas las fechas' };
  return map[ventaDateFilter] || 'del ' + ventaDateFilter;
}

// Etiqueta de la columna "Pago": para QR y para el pago mixto muestra además quién cobró el QR.
function pagoLabel(v){
  if(v.metodoPago === 'mixto'){
    let txt = '💵📱 QR y Efectivo';
    if(v.qrPersona) txt += ` · ${escapeHtml(v.qrPersona)}`;
    return txt;
  }
  const base = PAYMENT_LABELS[v.metodoPago] || v.metodoPago || '';
  return v.metodoPago === 'qr' && v.qrPersona ? `${base} · ${escapeHtml(v.qrPersona)}` : base;
}

// Parte de una venta que entra por QR (0 si es de contado).
function qrMontoDeVenta(v){
  if(v.metodoPago === 'qr') return parseFloat(v.total) || 0;
  if(v.metodoPago === 'mixto') return parseFloat(v.qrMonto) || 0;
  return 0;
}
// Parte de una venta que entra por efectivo (0 si es solo QR).
function efectivoMontoDeVenta(v){
  if(v.metodoPago === 'efectivo') return parseFloat(v.total) || 0;
  if(v.metodoPago === 'mixto') return parseFloat(v.efectivoMonto) || 0;
  return 0;
}

// "CAMBIO": monto inicial (fondo de cambio) con el que arranca la cuenta del
// día. Se guarda POR DÍA (uno por fecha) y solo en este dispositivo, para que
// al cambiar el filtro (Hoy/Ayer/otra fecha) cada día tenga su propio monto.
// Si todavía no hay un monto para el día de hoy, usa el valor que estaba
// guardado antes (por modo).
function cambioStorageKey(fechaKey){
  const fecha = fechaKey || dateKeyOffset(0);
  return 'stockferre_cambio_v1_' + currentModo + '_' + fecha;
}
function getCambioBase(fechaKey){
  const key = cambioStorageKey(fechaKey);
  try{
    const v = localStorage.getItem(key);
    if(v != null) return parseFloat(v) || 0;
  }catch(e){}
  if(!fechaKey || fechaKey === dateKeyOffset(0)){
    try{ return parseFloat(localStorage.getItem('stockferre_cambio_v1_' + currentModo)) || 0; }catch(e){}
  }
  return 0;
}
function setCambioBase(v, fechaKey){
  const val = Math.max(0, parseFloat(v) || 0);
  try{ localStorage.setItem(cambioStorageKey(fechaKey), String(val)); }catch(e){}
}
// "Ajuste de cuentas": resume el dinero de las ventas que se están mostrando
// (por defecto las de hoy) en Total Bs, Efectivo y QR, con el desglose de QR
// por cada persona que cobra. En los pagos mixtos, cada parte va a su columna.
// La suma total empieza desde el monto de "CAMBIO" del DÍA (ya no desde cero).
function renderAjusteCuentas(list){
  const panel = document.getElementById('ajusteCuentas');
  if(!panel) return;
  list = list || [];
  const dia = ventaFilterDateKey() || dateKeyOffset(0);
  const total = list.reduce((s,v)=> s + (parseFloat(v.total) || 0), 0);
  const efectivo = list.reduce((s,v)=> s + efectivoMontoDeVenta(v), 0);
  const qr = list.reduce((s,v)=> s + qrMontoDeVenta(v), 0);
  // Los gastos/préstamos marcados como "ajustar" del día que se ve restan del total vendido.
  const gastosAjustados = gastosPrestamosDelDia().filter(g=>g.ajustar).reduce((s,g)=> s + (parseFloat(g.bs)||0), 0);
  const cambioBase = getCambioBase(dia);
  const totalFinal = cambioBase + total - gastosAjustados;
  document.getElementById('ajusteTotal').textContent = fmtMoney(totalFinal);
  document.getElementById('ajusteEfectivo').textContent = fmtMoney(efectivo);
  document.getElementById('ajusteQr').textContent = fmtMoney(qr);
  // Refleja el monto de CAMBIO guardado (sin pisar lo que se está escribiendo).
  const cambioEl = document.getElementById('ajusteCambio');
  if(cambioEl && document.activeElement !== cambioEl) cambioEl.value = cambioBase;
  const notaG = document.getElementById('ajusteGastosNota');
  if(notaG){
    if(gastosAjustados > 0){
      notaG.style.display = '';
      notaG.textContent = `(−${fmtMoney(gastosAjustados)} en gastos/préstamos ajustados del total)`;
    }else{
      notaG.style.display = 'none';
      notaG.textContent = '';
    }
  }
  const fechaEl = document.getElementById('ajusteFecha');
  if(fechaEl) fechaEl.textContent = ventasFilterLabel();
  const det = document.getElementById('ajusteQrDetalle');
  const porPersona = QR_PERSONAS
    .map(p => ({ persona: p, total: list.filter(v => v.qrPersona === p).reduce((s,v)=> s + qrMontoDeVenta(v), 0) }))
    .filter(x => x.total > 0);
  if(det){
    if(porPersona.length){
      det.style.display = '';
      det.innerHTML = porPersona.map(x => `<button type="button" class="ajuste-qr-chip" data-qr-persona="${escapeHtml(x.persona)}" title="Ver los pagos por QR de ${escapeHtml(x.persona)}">📱 <strong>${escapeHtml(x.persona)}</strong> · ${fmtMoney(x.total)}</button>`).join('');
    }else{
      det.style.display = 'none';
      det.innerHTML = '';
    }
  }
}

// Gastos/préstamos del DÍA que se está viendo en Ventas (Hoy/Ayer/una fecha;
// si el filtro es "Todas" muestra todos). Son los que ajustan el estado de
// cuentas. Los de "sin color" solo se ven en el invitado: no se envían a ningún modo.
function gastosPrestamosDelDia(){
  const dia = ventaFilterDateKey();
  return (db.gastosPrestamos || []).filter(g => {
    if(dia && ventaFechaKey(g.fecha) !== dia) return false;
    if(currentModo !== 'invitado' && g.modo === 'ninguno') return false;
    return true;
  });
}

// Quita duplicados por id (misma fecha/hora al escribirse en ambos modos).
function dedupeGastosById(list){
  const map = new Map();
  (list || []).forEach(g => { if(g && g.id != null && !map.has(g.id)) map.set(g.id, g); });
  return Array.from(map.values());
}

// Almacén NEUTRO del invitado: gastos/préstamos "sin color" que NO se mandan
// ni a Manuales ni a Eléctricas. Viven solo en este dispositivo del invitado.
function loadGuestNeutralGastos(){
  try{
    const raw = localStorage.getItem('stockferre_guest_gastos_v1');
    if(raw){
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    }
  }catch(e){}
  return [];
}
function saveGuestNeutralGastos(list){
  try{ localStorage.setItem('stockferre_guest_gastos_v1', JSON.stringify(list)); }catch(e){}
}

// Guarda los gastos/préstamos. En modo invitado se reparten según el color:
// naranja → Manuales, amarillo → Eléctricas, sin color → se queda en el almacén
// neutral (NO se envía a ningún modo). En los modos del dueño se guarda normal.
function saveGastosPrestamos(){
  if(currentModo === 'invitado'){
    const g = dedupeGastosById(db.gastosPrestamos || []);
    ['manual','electrico'].forEach(modo => {
      const m = loadModoDB(modo);
      m.gastosPrestamos = g.filter(x => {
        const md = (x.modo === undefined || x.modo === null) ? 'ninguno' : x.modo;
        return md === modo;
      });
      persistModoDB(modo, m);
    });
    saveGuestNeutralGastos(g.filter(x => {
      const md = (x.modo === undefined || x.modo === null) ? 'ninguno' : x.modo;
      return md === 'ninguno';
    }));
  }else{
    // Los "sin color" no pertenecen a la base de un modo: se descartan.
    db.gastosPrestamos = (db.gastosPrestamos || []).filter(x => x.modo !== 'ninguno');
    saveDB();
  }
}

// Lista de gastos/préstamos del día + total (estilo "Historial de pagos QR").
// Cada fila tiene un punto de color (naranja = Manuales, amarillo = Eléctricas) que
// redirige el gasto al modo elegido, y su recuadro "Ajustar" para tachar los
// que restan del total del ajuste de cuentas.
function renderGastosPrestamos(){
  const listEl = document.getElementById('gastosPrestamosList');
  const totalEl = document.getElementById('gastosPrestamosTotal');
  const nota = document.getElementById('gpAjustadoNota');
  if(!listEl || !totalEl || !nota) return;
  const esInvitado = currentModo === 'invitado';
  const legendEl = document.getElementById('gpLegend');
  if(legendEl) legendEl.style.display = esInvitado ? '' : 'none';
  const fechaEl = document.getElementById('gpFecha');
  if(fechaEl) fechaEl.textContent = ventasFilterLabel();
  const list = dedupeGastosById(gastosPrestamosDelDia());
  listEl.innerHTML = list.map(g => {
    const md = (g.modo === undefined || g.modo === null) ? 'ninguno' : g.modo;
    const dotCls = md === 'electrico' ? 'el' : (md === 'manual' ? 'man' : 'none');
    const etiquetaModo = md === 'electrico' ? 'Eléctricas (amarillo)' : (md === 'manual' ? 'Manuales (naranja)' : 'Sin color');
    const dotTitle = esInvitado
      ? etiquetaModo + ' — toca para cambiar'
      : etiquetaModo;
    const dotBtn = esInvitado
      ? `<button type="button" class="gp-modo-dot ${dotCls}" title="${dotTitle}" data-gp-modo="${escapeHtml(g.id)}"></button>`
      : `<span class="gp-modo-dot static ${dotCls}" title="${dotTitle}"></span>`;
    return `
    <div class="gp-row">
      <strong>${fmtMoney(g.bs)}</strong>
      <span class="gp-obs">${g.observacion ? escapeHtml(g.observacion) : '-'}</span>
      ${dotBtn}
      <label class="gp-tag" title="Restar del total del ajuste de cuentas">
        <input type="checkbox" class="gp-chk" data-gp-ajustar="${escapeHtml(g.id)}" ${g.ajustar ? 'checked' : ''}> Ajustar
      </label>
      <button type="button" class="btn-icon" title="Eliminar" data-delete-gp="${escapeHtml(g.id)}">🗑️</button>
    </div>`;
  }).join('');
  const totalG = list.reduce((s,g)=> s + (parseFloat(g.bs)||0), 0);
  const ajustados = list.filter(g=>g.ajustar).reduce((s,g)=> s + (parseFloat(g.bs)||0), 0);
  totalEl.innerHTML = `Total <strong>${fmtMoney(totalG)}</strong>`;
  nota.textContent = ajustados > 0 ? `Ajusta al estado de cuentas: −${fmtMoney(ajustados)}` : '';
}

function addGastoPrestamo(data){
  db.gastosPrestamos.push({
    id: uid('gp'),
    bs: parseFloat(data.bs) || 0,
    observacion: data.observacion || '',
    ajustar: false,
    modo: data.modo || (currentModo === 'invitado' ? 'ninguno' : currentModo),
    // Se guarda en el día que se está viendo en Ventas (si es "Todas", hoy).
    fecha: ventaFilterDateKey() || todayISO()
  });
  saveGastosPrestamos();
  renderVentas();
}

// Cambia el color/destino del gasto/préstamo: naranja → Manuales, amarillo →
// Eléctricas, gris (sin color) → no se envía a ningún modo.
function toggleGastoPrestamoModo(id){
  const g = (db.gastosPrestamos || []).find(x => x.id === id);
  if(!g) return;
  const orden = ['manual','electrico','ninguno'];
  const cur = (g.modo === undefined || g.modo === null) ? 'ninguno' : g.modo;
  const nuevo = orden[(orden.indexOf(cur) + 1) % orden.length];
  if(currentModo === 'invitado'){
    g.modo = nuevo;
    saveGastosPrestamos();
  }else{
    // El dueño está viendo UNA base: el gasto se saca de ambas bases y queda
    // en la que corresponde al color elegido (gris = se queda en la actual,
    // sin enviarse a ningún modo).
    const otro = currentModo === 'manual' ? 'electrico' : 'manual';
    g.modo = nuevo;
    const m = loadModoDB(otro);
    m.gastosPrestamos = (m.gastosPrestamos || []).filter(x => x.id !== id);
    db.gastosPrestamos = (db.gastosPrestamos || []).filter(x => x.id !== id);
    if(nuevo === otro){
      m.gastosPrestamos.push(g);
    }else{
      db.gastosPrestamos.push(g);
    }
    persistModoDB(otro, m);
    saveDB();
    toast('Gasto enviado a ' + (nuevo === 'electrico' ? 'Eléctricas' : nuevo === 'manual' ? 'Manuales' : 'sin modo'), 'success');
  }
  renderVentas();
}

function toggleGastoPrestamoAjustar(id){
  const g = db.gastosPrestamos.find(x => x.id === id);
  if(!g) return;
  g.ajustar = !g.ajustar;
  saveGastosPrestamos();
  renderVentas();
}

function deleteGastoPrestamo(id){
  db.gastosPrestamos = (db.gastosPrestamos || []).filter(x => x.id !== id);
  saveGastosPrestamos();
  renderVentas();
}

function syncVentasChips(){
  document.querySelectorAll('.venta-date-chip').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.ventaDate === ventaDateFilter);
  });
  const input = document.getElementById('ventaDateInput');
  if(input) input.value = /^\d{4}-\d{2}-\d{2}$/.test(ventaDateFilter) ? ventaDateFilter : '';
}

// Recordatorio semanal de respaldo: no es un export automático (el navegador
// no puede descargar sin que toques nada), pero te lo recuerda cada 7 días.
const EXPORT_PROMPT_KEY = 'stockferre_export_prompt_v1';
const EXPORT_PROMPT_DAYS = 7;
function getLastExportPrompt(){
  try{ return localStorage.getItem(EXPORT_PROMPT_KEY) || ''; }catch(e){ return ''; }
}
function markExportPrompt(){
  try{ localStorage.setItem(EXPORT_PROMPT_KEY, dateKeyOffset(0)); }catch(e){}
}
function daysSinceExportPrompt(){
  const last = getLastExportPrompt();
  if(!last) return Infinity;
  try{ return Math.floor((new Date() - new Date(last)) / 86400000); }catch(e){ return Infinity; }
}
function maybeShowExportReminder(){
  const el = document.getElementById('exportReminder');
  if(!el) return;
  if(currentRole === 'guest' || daysSinceExportPrompt() < EXPORT_PROMPT_DAYS){
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  el.innerHTML = `
    <span>💾 Hace más de una semana que no haces un respaldo de las ventas. Es recomendable exportarlas para que el registro no crezca demasiado.</span>
    <button class="btn btn-secondary btn-sm" id="btnExportNow">📤 Exportar ahora</button>
    <button class="btn btn-secondary btn-sm" id="btnDismissExport">Omitir</button>
  `;
}

// Ganancia neta de una venta = (precio de venta por unidad − precio de compra)
// × cantidad. Si el producto ya no existe (o fue "OTRO") no se puede calcular.
function gananciaVenta(v){
  const p = getProductoByCodigo(v.codigo);
  if(!p) return null;
  const costo = parseFloat(p.precioCompra) || 0;
  const unit = parseFloat(v.precioUnitario) || 0;
  return (unit - costo) * (parseFloat(v.cantidad) || 1);
}

// En el invitado, el resumen de Ventas muestra también el total vendido al
// precio de venta separado por cada modo: Manuales y Eléctricas. A cada modo se
// le restan los gastos/préstamos del día que llevan su color (naranja →
// Manuales, amarillo → Eléctricas; los "sin color" no restan de ninguno).
function guestModoTotalesHTML(list){
  const gastos = dedupeGastosById(gastosPrestamosDelDia());
  const gastoPorModo = modo => gastos.filter(g=>g.modo === modo).reduce((s,g)=> s + (parseFloat(g.bs)||0), 0);
  const manVendido = (list||[]).filter(v=>v.modo === 'manual').reduce((s,v)=> s + (parseFloat(v.total)||0), 0);
  const elVendido = (list||[]).filter(v=>v.modo === 'electrico').reduce((s,v)=> s + (parseFloat(v.total)||0), 0);
  const man = manVendido - gastoPorModo('manual');
  const el = elVendido - gastoPorModo('electrico');
  return `<span class="ventas-modo-totales"><span class="modo-total man">🛠️ Manuales: <strong>${fmtMoney(man)}</strong></span> · <span class="modo-total el">⚡ Eléctricas: <strong>${fmtMoney(el)}</strong></span></span>`;
}

function renderVentas(){
  const tbody = document.querySelector('#ventasTable tbody');
  const summary = document.getElementById('ventasSummary');
  const colspan = currentRole === 'guest' ? 9 : 10;

  if(db.ventas.length === 0){
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${colspan}">Todavía no registraste ninguna venta.</td></tr>`;
    summary.innerHTML = currentRole === 'guest' ? `0 ventas<br>${guestModoTotalesHTML([])}` : '0 ventas';
    renderAjusteCuentas([]);
    renderGastosPrestamos();
    syncVentasChips();
    maybeShowExportReminder();
    return;
  }

  const list = ventasFiltradas();
  if(list.length === 0){
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${colspan}">No hay ventas ${escapeHtml(ventasFilterLabel())}.</td></tr>`;
    summary.innerHTML = currentRole === 'guest'
      ? `0 ventas ${escapeHtml(ventasFilterLabel())}<br>${guestModoTotalesHTML([])}`
      : `0 ventas ${escapeHtml(ventasFilterLabel())}`;
    renderAjusteCuentas([]);
    renderGastosPrestamos();
    syncVentasChips();
    maybeShowExportReminder();
    return;
  }

  tbody.innerHTML = list.map((v, idx) => {
    const gan = gananciaVenta(v);
    const ganCell = gan === null ? '<td class="admin-only">-</td>' : `<td class="admin-only"><strong>${fmtMoney(gan)}</strong></td>`;
    // Acciones: todos pueden editar la venta; solo el dueño puede eliminarla.
    const accionesCell = `<td><button class="btn-icon" title="Editar venta" data-edit-venta="${v.id}">✏️</button><button class="btn-icon" title="Eliminar" data-delete-venta="${v.id}">🗑️</button></td>`;
    return `
    <tr>
      <td class="venta-num">${idx + 1}</td>
      <td>${fmtHistoryDate(v.fecha)}</td>
      <td><strong>${escapeHtml(v.codigo)}</strong></td>
      <td>${escapeHtml(v.nombre)}</td>
      <td>${v.cantidad}</td>
      <td>${fmtMoney(v.precioUnitario)}</td>
      <td><strong>${fmtMoney(v.total)}</strong></td>
      ${ganCell}
      <td>${pagoLabel(v)}</td>
      ${accionesCell}
    </tr>`;
  }).join('');

  const totalMonto = list.reduce((sum, v) => sum + v.total, 0);
  if(currentRole === 'guest'){
    // El invitado solo ve la suma de lo vendido (precio de venta) por cada modo.
    summary.innerHTML = `${list.length} venta${list.length === 1 ? '' : 's'} ${escapeHtml(ventasFilterLabel())} · Total <strong>${fmtMoney(totalMonto)}</strong><br>${guestModoTotalesHTML(list)}`;
  }else{
    // El dueño ve el total vendido y la ganancia neta (total − costo de compra).
    let costoTotal = 0;
    list.forEach(v => {
      const p = getProductoByCodigo(v.codigo);
      if(p) costoTotal += (parseFloat(p.precioCompra) || 0) * (parseFloat(v.cantidad) || 1);
    });
    const gananciaNeta = totalMonto - costoTotal;
    summary.textContent = `${list.length} venta${list.length === 1 ? '' : 's'} ${ventasFilterLabel()} · Total ${fmtMoney(totalMonto)} · Ganancia neta ${fmtMoney(gananciaNeta)}`;
  }
  renderAjusteCuentas(list);
  renderGastosPrestamos();
  syncVentasChips();
  maybeShowExportReminder();
}

// Borra ventas de hace más de 3 meses para que la base no crezca sin límite
// (se recomienda exportarlas antes con "Exportar CSV").
function purgeVentasAntiguas(){
  const corte = new Date();
  corte.setDate(corte.getDate() - 90);
  const corteKey = localDateKey(corte);
  const antes = db.ventas.length;
  db.ventas = db.ventas.filter(v => ventaFechaKey(v.fecha) >= corteKey);
  const borradas = antes - db.ventas.length;
  saveDB();
  renderVentas();
  if(borradas > 0) toast(`${borradas} venta(s) antigua(s) eliminadas`, 'success');
  else toast('No había ventas antiguas que borrar', 'warning');
}

/* -------------------------------------------------------------------------
   4d. PRODUCTOS MÁS VENDIDOS (solo dueño)
   Cuenta cuántas unidades vendió cada producto (suma de cantidades en
   Ventas) y muestra TODOS los productos ordenados del más al menos vendido
   (los sin ventas quedan al final con 0). Muestra su stock actual y el
   stock mínimo (editable en la misma tabla). Los 20 primeros llevan
   estrella dorada. Se puede filtrar por mes o ver todo el año.
   ------------------------------------------------------------------------- */

let topVentasMesFilter = '';

// Ventas consideradas para el top: todas, o solo las de un mes ('YYYY-MM').
function ventasTopFiltradas(){
  if(!topVentasMesFilter) return db.ventas || [];
  return (db.ventas || []).filter(v => (v.fecha || '').slice(0,7) === topVentasMesFilter);
}

// Llena el selector con los meses que tienen ventas + la opción "Todo el año".
function syncTopVentasMesFilter(){
  const el = document.getElementById('topVentasMes');
  if(!el) return;
  const meses = [...new Set((db.ventas || []).map(v => (v.fecha || '').slice(0,7)).filter(Boolean))].sort().reverse();
  let html = '<option value="">Todo el año</option>';
  meses.forEach(m => {
    const [y, mo] = m.split('-').map(Number);
    const nombre = new Date(y, mo-1, 1).toLocaleString('es', { month:'long' });
    const label = nombre.charAt(0).toUpperCase() + nombre.slice(1) + ' ' + y;
    html += `<option value="${m}" ${m === topVentasMesFilter ? 'selected' : ''}>${label}</option>`;
  });
  el.innerHTML = html;
}

function topVentasPeriodoLabel(){
  if(!topVentasMesFilter) return 'de todo el año';
  const [y, mo] = topVentasMesFilter.split('-').map(Number);
  const nombre = new Date(y, mo-1, 1).toLocaleString('es', { month:'long' });
  return `de ${nombre.charAt(0).toUpperCase() + nombre.slice(1)} ${y}`;
}

// [{p, vendidos}] ordenado de más a menos vendido. Incluye todos los
// productos del inventario (los sin ventas van al final con vendidos = 0).
function productosMasVendidos(){
  const cantidades = {};
  ventasTopFiltradas().forEach(v => {
    const c = normalize(v.codigo);
    if(!c) return;
    cantidades[c] = (cantidades[c] || 0) + (parseFloat(v.cantidad) || 0);
  });
  return db.productos
    .map(p => ({ p, vendidos: cantidades[normalize(p.codigo)] || 0 }))
    .sort((a,b)=> b.vendidos - a.vendidos || normalize(a.p.codigo).localeCompare(normalize(b.p.codigo)));
}

function renderTopVentas(){
  const tbody = document.querySelector('#topVentasTable tbody');
  const summary = document.getElementById('topVentasSummary');
  if(!tbody || !summary) return;
  syncTopVentasMesFilter();
  const rows = productosMasVendidos();
  if(rows.length === 0){
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">Todavía no hay productos en el inventario.</td></tr>`;
    summary.textContent = '0 productos';
    return;
  }
  tbody.innerHTML = rows.map((r, i) => {
    const pos = i + 1;
    const top20 = pos <= 20;
    const bajo = (r.p.stockMin || 0) > 0 && r.p.stock <= r.p.stockMin;
    return `
    <tr class="${top20 ? 'top-row' : ''}">
      <td>${top20 ? `<span class="top-star" title="Top ${pos} más vendido">⭐ ${pos}</span>` : pos}</td>
      <td><strong>${escapeHtml(r.p.nombre)}</strong><br><small class="hint">${escapeHtml(r.p.codigo)}</small></td>
      <td><strong>${r.vendidos}</strong></td>
      <td>${r.p.stock}${bajo ? ' <span class="badge badge-danger-soft">Bajo</span>' : ''}</td>
      <td><input type="number" class="input stock-min-input" data-codigo="${escapeHtml(r.p.codigo)}" value="${r.p.stockMin || 0}" min="0" step="1" title="Editar stock mínimo"></td>
    </tr>`;
  }).join('');
  const conVentas = rows.filter(r => r.vendidos > 0).length;
  summary.textContent = `Todos los productos (${rows.length}) ${topVentasPeriodoLabel()} · ${conVentas} con ventas · ⭐ los 20 primeros son los más vendidos`;
}

function exportTopVentasCSV(){
  const rows = productosMasVendidos();
  if(rows.length === 0){ toast('No hay productos para exportar', 'error'); return; }
  const header = ['POSICION','CODIGO','PRODUCTO','VENDIDOS','STOCK','STOCK_MINIMO'];
  const data = rows.map((r, i) => [i + 1, csvText(r.p.codigo), r.p.nombre, csvNumber(r.vendidos, 0), csvNumber(r.p.stock, 0), csvNumber(r.p.stockMin || 0, 0)]);
  const sufijo = topVentasMesFilter ? topVentasMesFilter : 'todo_el_ano';
  downloadCSV(`stockferre_mas_vendidos_${sufijo}.csv`, header, data);
  toast('Top de más vendidos exportado', 'success');
}

// Importa solo la columna STOCK_MINIMO (por CODIGO) de un CSV exportado,
// y actualiza el stock mínimo de cada producto.
function importTopVentasCSV(file){
  const reader = new FileReader();
  reader.onload = (e)=>{
    try{
      const rows = parseCSV(e.target.result);
      if(rows.length < 2){
        toast('El archivo CSV no tiene datos', 'error');
        return;
      }
      const headers = rows[0].map(normalizeHeader);
      const idxCodigo = headers.indexOf('CODIGO');
      const idxMin = headers.findIndex(h => h.includes('STOCK_MINIMO') || h.includes('STOCK MINIMO') || h.includes('STOCK MIN'));
      if(idxCodigo === -1 || idxMin === -1){
        toast('El CSV debe tener columnas CODIGO y STOCK_MINIMO', 'error');
        return;
      }
      let aplicados = 0;
      for(let i = 1; i < rows.length; i++){
        const r = rows[i];
        const codigo = String(r[idxCodigo] || '').trim();
        const v = parseFloat(String(r[idxMin]).replace(',','.'));
        if(!codigo || isNaN(v)) continue;
        const p = getProductoByCodigo(codigo);
        if(!p) continue;
        p.stockMin = v < 0 ? 0 : Math.round(v);
        aplicados++;
      }
      saveDB();
      renderTopVentas();
      renderProductos();
      toast(`Stock mínimo actualizado para ${aplicados} producto(s)`, 'success');
    }catch(err){
      console.error(err);
      toast('No se pudo leer el archivo CSV. Verifica el formato.', 'error');
    }
  };
  reader.onerror = ()=> toast('Error al leer el archivo', 'error');
  reader.readAsText(file, 'UTF-8');
}

/* -------------------------------------------------------------------------
   4e. PEDIDOS / REPOSICIÓN (solo dueño)
   Lista TODOS los productos ordenados de menor a mayor stock (primero los
   agotados, luego stock 1, 2, ...). Permite filtrar por marca y armar el
   pedido: stock mínimo editable y cantidad a pedir editable, con el botón
   "🪄 Llenar" que pone la cantidad exacta que falta para alcanzar el stock
   mínimo. Las cantidades del pedido se guardan solo en memoria mientras
   estás en la pestaña (no se guardan en la base de datos).
   ------------------------------------------------------------------------- */

const pedidoCantidades = {};
let pedidoRows = [];

// Cantidad exacta para llenar el stock mínimo (0 si el stock ya está bien).
function pedidoCantidadLlenar(p){
  return Math.max(0, (p.stockMin || 0) - (p.stock || 0));
}

// Cantidad a pedir: la que venga prellenada (llenar hasta el stock mínimo),
// o la que el usuario haya editado manualmente en esta sesión.
function pedidoCant(p){
  const key = normalize(p.codigo);
  return (key in pedidoCantidades) ? pedidoCantidades[key] : pedidoCantidadLlenar(p);
}

function updatePedidoSummary(){
  const summary = document.getElementById('pedidoSummary');
  if(!summary) return;
  let unidades = 0, costo = 0;
  pedidoRows.forEach(({ p }) => {
    const cant = pedidoCant(p);
    unidades += cant;
    costo += cant * (parseFloat(p.precioCompra) || 0);
  });
  const n = pedidoRows.length;
  summary.textContent = `${n} producto${n === 1 ? '' : 's'} · ${unidades} unidades a pedir · Costo estimado ${fmtMoney(costo)}`;
}

function renderPedidos(){
  const tbody = document.querySelector('#pedidosTable tbody');
  const summary = document.getElementById('pedidoSummary');
  const marcaSel = document.getElementById('pedidoMarcaFilter');
  if(!tbody || !summary || !marcaSel) return;

  // Selector de marcas: todas las marcas que existan en la base de datos
  const marcas = [...new Set(db.productos.map(p => (p.marca || '').trim()).filter(Boolean))].sort((a,b)=> a.localeCompare(b, 'es'));
  const selActual = marcaSel.value;
  marcaSel.innerHTML = '<option value="">Todas las marcas</option>' + marcas.map(m => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('');
  marcaSel.value = marcas.includes(selActual) ? selActual : '';

  let list = db.productos.slice();
  if(marcaSel.value) list = list.filter(p => (p.marca || '').trim() === marcaSel.value);
  // Orden: stock ascendente (0 primero, luego 1, 2...) y por nombre si empatan
  list.sort((a,b)=> (a.stock || 0) - (b.stock || 0) || a.nombre.localeCompare(b.nombre, 'es'));
  pedidoRows = list;

  if(list.length === 0){
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">No hay productos${marcaSel.value ? ' de esa marca' : ''}.</td></tr>`;
    summary.textContent = '0 productos · 0 unidades · Bs 0.00';
    return;
  }

  tbody.innerHTML = list.map((p, i) => {
    const bajo = (p.stockMin || 0) > 0 && p.stock <= p.stockMin;
    const cant = pedidoCant(p);
    return `
    <tr class="${bajo ? 'pedido-bajo' : ''}">
      <td>${i + 1}</td>
      <td>${p.marca ? escapeHtml(p.marca) : '-'}</td>
      <td><strong>${escapeHtml(p.nombre)}</strong><br><small class="hint">${escapeHtml(p.codigo)}</small></td>
      <td>${p.stock}${bajo ? ' <span class="badge badge-danger-soft">Bajo</span>' : ''}</td>
      <td><input type="number" class="input pedido-stockmin-input" data-codigo="${escapeHtml(p.codigo)}" value="${p.stockMin || 0}" min="0" step="1" title="Editar stock mínimo"></td>
      <td><input type="number" class="input pedido-cant-input" data-codigo="${escapeHtml(p.codigo)}" value="${cant}" min="0" step="1" title="Cantidad a pedir (editable)"></td>
    </tr>`;
  }).join('');

  updatePedidoSummary();
}

// Exporta el pedido visible (según el filtro de marca) con las cantidades.
function exportPedidosCSV(){
  if(pedidoRows.length === 0){ toast('No hay productos para exportar', 'error'); return; }
  const header = ['POSICION','MARCA','CODIGO','PRODUCTO','STOCK','STOCK_MINIMO','CANTIDAD_PEDIR'];
  const data = pedidoRows.map(({ p }, i) => [
    i + 1, p.marca || '', csvText(p.codigo), p.nombre,
    csvNumber(p.stock, 0), csvNumber(p.stockMin || 0, 0), csvNumber(pedidoCant(p), 0)
  ]);
  downloadCSV(`stockferre_pedidos_${todayISO().slice(0,10)}.csv`, header, data);
  toast('Pedido exportado', 'success');
}

// Importa un CSV del pedido: actualiza el stock mínimo (en la base) por CODIGO
// y las cantidades a pedir (en memoria, para esta sesión).
function importPedidosCSV(file){
  const reader = new FileReader();
  reader.onload = (e)=>{
    try{
      const rows = parseCSV(e.target.result);
      if(rows.length < 2){
        toast('El archivo CSV no tiene datos', 'error');
        return;
      }
      const headers = rows[0].map(normalizeHeader);
      const idxCodigo = headers.indexOf('CODIGO');
      if(idxCodigo === -1){
        toast('El CSV debe tener la columna CODIGO', 'error');
        return;
      }
      const idxMin = headers.findIndex(h => h.includes('STOCK_MINIMO') || h.includes('STOCK MINIMO') || h.includes('STOCK MIN'));
      const idxCant = headers.findIndex(h => h.includes('CANTIDAD') || h.includes('CANT'));
      let mins = 0, cantidades = 0;
      const minUpdated = [];
      for(let i = 1; i < rows.length; i++){
        const r = rows[i];
        const codigo = String(r[idxCodigo] || '').trim();
        if(!codigo) continue;
        const p = getProductoByCodigo(codigo);
        if(!p) continue;
        if(idxMin > -1 && String(r[idxMin]).trim() !== ''){
          const v = parseFloat(String(r[idxMin]).replace(',','.'));
          if(!isNaN(v)){
            p.stockMin = v < 0 ? 0 : Math.round(v);
            minUpdated.push(p);
            mins++;
          }
        }
        if(idxCant > -1 && String(r[idxCant]).trim() !== ''){
          const v = parseFloat(String(r[idxCant]).replace(',','.'));
          if(!isNaN(v)){
            pedidoCantidades[normalize(codigo)] = v < 0 ? 0 : Math.round(v);
            cantidades++;
          }
        }
      }
      saveDB();
      syncProductoDocs(minUpdated, currentModo); // el stock mínimo importado también va a la nube
      renderPedidos();
      renderProductos();
      renderTopVentas();
      toast(`Importado: stock mínimo ${mins} · cantidades a pedir ${cantidades}`, 'success');
    }catch(err){
      console.error(err);
      toast('No se pudo leer el archivo CSV. Verifica el formato.', 'error');
    }
  };
  reader.onerror = ()=> toast('Error al leer el archivo', 'error');
  reader.readAsText(file, 'UTF-8');
}

/* -------------------------------------------------------------------------
   4f. COMPRAS (registro de compras de productos, solo dueño)
   Es una pestaña paralela a Ventas: filtro por fechas (Hoy/Ayer/Anteayer/
   fecha/Todas), exportar/importar CSV, borrar antiguas y vaciar. Al registrar
   una compra se aumenta el stock y, OPCIONALMENTE, se actualizan la marca y
   los precios del producto (sin tocar las ventas ya registradas, que guardan
   su propio precio en cada registro).
   ------------------------------------------------------------------------- */

let compraDateFilter = 'hoy';
let compraSearch = ''; // texto del buscador de la pestaña Ingresos

function comprasFiltradas(){
  return db.compras.filter(c => {
    const k = ventaFechaKey(c.fecha);
    if(compraDateFilter === 'todas') return true;
    if(compraDateFilter === 'hoy') return k === dateKeyOffset(0);
    if(compraDateFilter === 'ayer') return k === dateKeyOffset(1);
    if(compraDateFilter === 'anteayer') return k === dateKeyOffset(2);
    if(/^\d{4}-\d{2}-\d{2}$/.test(compraDateFilter)) return k === compraDateFilter;
    return true;
  });
}
function comprasFilterLabel(){
  const map = { hoy: 'de hoy', ayer: 'de ayer', anteayer: 'de anteayer', todas: 'de todas las fechas' };
  return map[compraDateFilter] || 'del ' + compraDateFilter;
}
function syncComprasChips(){
  document.querySelectorAll('.compra-date-chip').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.compraDate === compraDateFilter);
  });
  const input = document.getElementById('compraDateInput');
  if(input) input.value = /^\d{4}-\d{2}-\d{2}$/.test(compraDateFilter) ? compraDateFilter : '';
}

// Agrupa los ingresos por código de producto. Si se pasa una lista (por
// ejemplo ya filtrada por fecha), agrupa solo esos.
function comprasPorProducto(lista){
  const map = new Map();
  (lista || db.compras).forEach(c => {
    if(!map.has(c.codigo)) map.set(c.codigo, []);
    map.get(c.codigo).push(c);
  });
  return map;
}

// La pestaña Ingresos muestra el filtro de fechas (Hoy/Ayer/otra fecha/Todas)
// como antes, y debajo la lista de PRODUCTOS con su historial de ingresos
// (compras) filtrada por fecha y con el buscador por código o descripción.
// Al hacer clic en un producto se abre su historial (fechas, proveedor,
// precio y cantidad).
function renderCompras(){
  const tbody = document.querySelector('#comprasTable tbody');
  const summary = document.getElementById('comprasSummary');
  if(!tbody || !summary) return;
  syncComprasChips();
  const colspan = 8;

  if(db.compras.length === 0){
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${colspan}">Todavía no registraste ningún ingreso. Usa "➕ Nuevo ingreso" para registrar tu primera compra.</td></tr>`;
    summary.textContent = '0 ingresos';
    maybeShowCompraReminder();
    return;
  }

  const filtradas = comprasFiltradas();
  if(filtradas.length === 0){
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${colspan}">No hay ingresos ${comprasFilterLabel()}.</td></tr>`;
    summary.textContent = `0 ingresos ${comprasFilterLabel()}`;
    maybeShowCompraReminder();
    return;
  }

  const grupos = comprasPorProducto(filtradas);
  let entries = [...grupos.entries()].map(([codigo, compras]) => {
    const ultima = compras.reduce((a,b)=> new Date(b.fecha) > new Date(a.fecha) ? b : a);
    return {
      codigo,
      nombre: compras[0].nombre || codigo,
      veces: compras.length,
      unidades: compras.reduce((s,x)=> s + (x.cantidad||0), 0),
      total: compras.reduce((s,x)=> s + (x.total||0), 0),
      ultimaFecha: ultima.fecha,
      ultimoPrecio: ultima.precioUnitario || 0
    };
  });

  const s = normalize(compraSearch);
  if(s){
    entries = entries.filter(e => normalize(e.codigo).includes(s) || normalize(e.nombre).includes(s));
  }
  entries.sort((a,b)=> a.nombre.localeCompare(b.nombre, 'es'));

  if(entries.length === 0){
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${colspan}">No hay ingresos que coincidan con la búsqueda.</td></tr>`;
    summary.textContent = `${filtradas.length} ingreso(s) ${comprasFilterLabel()}`;
    maybeShowCompraReminder();
    return;
  }

  tbody.innerHTML = entries.map(e => `
    <tr data-compra-prod="${escapeHtml(e.codigo)}" style="cursor:pointer;" title="Ver historial de ingresos">
      <td><strong>${escapeHtml(e.codigo)}</strong></td>
      <td>${escapeHtml(e.nombre)}</td>
      <td>${e.veces}</td>
      <td>${e.unidades}</td>
      <td>${fmtMoney(e.ultimoPrecio)}</td>
      <td>${fmtHistoryDate(e.ultimaFecha)}</td>
      <td><strong>${fmtMoney(e.total)}</strong></td>
      <td><button class="btn btn-secondary btn-sm" data-view-compra-history="${escapeHtml(e.codigo)}">📋 Ver historial</button></td>
    </tr>
  `).join('');

  const totalGral = entries.reduce((s,e)=> s + e.total, 0);
  summary.textContent = `${entries.length} producto(s) · ${filtradas.length} ingreso(s) ${comprasFilterLabel()} · ${fmtMoney(totalGral)} invertido`;
  maybeShowCompraReminder();
}

// Abre la ventana con el historial de ingresos (compras) del producto: cada
// compra con su fecha, proveedor, precio de compra, cantidad y observaciones.
// Color que identifica a cada persona que cobra por QR: se usa como borde del
// historial de pagos para distinguirlas de un vistazo.
function qrPersonaColor(persona){
  const colores = { 'Abner': '#e53e3e', 'José': '#38a169', 'Jona': '#3182ce', 'Richard': '#dd6b20' };
  return colores[persona] || '#805ad5';
}
// Pinta el borde de un modal con el color indicado.
function pintarBordeModal(modalId, color){
  const modal = document.getElementById(modalId);
  if(modal) modal.style.border = `3px solid ${color}`;
}

function openCompraHistorial(codigo){
  const compras = db.compras.filter(c => c.codigo === codigo);
  const p = getProductoByCodigo(codigo);
  const nombre = compras[0]?.nombre || (p ? p.nombre : codigo);
  document.getElementById('histProdInfo').innerHTML = `📦 <strong>${escapeHtml(nombre)}</strong> · <span style="font-size:12px;">Código: ${escapeHtml(codigo)}</span>`;
  const tbody = document.querySelector('#histComprasTable tbody');
  if(compras.length === 0){
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Todavía no hay ingresos registrados para este producto.</td></tr>`;
  }else{
    // Últimos 5 ingresos: fecha anterior arriba y la más reciente abajo, y
    // solo se muestra la fecha (sin la hora).
    const ultimas = compras.slice()
      .sort((a,b)=> new Date(a.fecha) - new Date(b.fecha))
      .slice(-5);
    tbody.innerHTML = ultimas.map(c => `
      <tr>
        <td>${fmtDateShort(c.fecha)}</td>
        <td>${escapeHtml(c.proveedor || '-')}</td>
        <td>${fmtMoney(c.precioUnitario)}</td>
        <td>${c.cantidad}</td>
        <td>${c.observaciones ? escapeHtml(c.observaciones) : '-'}</td>
        <td><button class="btn-icon" title="Eliminar ingreso" data-delete-compra="${c.id}">🗑️</button></td>
      </tr>
    `).join('');
  }
  pintarBordeModal('modalCompraHistorial', '#805ad5');
  openModal('modalCompraHistorial');
}

// Historial de pagos por QR de una persona: ventana con cada venta donde esa
// persona cobró por QR. Muestra el número de la venta, fecha, código,
// producto, cuánto fue en QR y (si fue mixta) cuánto en efectivo, y el total.
function openQrHistorial(persona){
  const ventas = db.ventas.filter(v => v.qrPersona === persona && qrMontoDeVenta(v) > 0);
  const info = document.getElementById('histQrInfo');
  const tbody = document.querySelector('#histQrTable tbody');
  if(!info || !tbody) return;
  info.innerHTML = `📱 <strong>${escapeHtml(persona)}</strong> · <span style="font-size:12px;">Pagos por QR de ${ventas.length} venta${ventas.length === 1 ? '' : 's'}</span>`;
  if(ventas.length === 0){
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">${escapeHtml(persona)} no tiene pagos por QR registrados.</td></tr>`;
  }else{
    tbody.innerHTML = ventas.map(v => {
      const nro = db.ventas.indexOf(v) + 1;
      const efCell = v.metodoPago === 'mixto' ? fmtMoney(efectivoMontoDeVenta(v)) : '-';
      return `
      <tr>
        <td>${nro}</td>
        <td>${fmtHistoryDate(v.fecha)}</td>
        <td><strong>${escapeHtml(v.codigo)}</strong></td>
        <td>${escapeHtml(v.nombre)}</td>
        <td><strong>${fmtMoney(qrMontoDeVenta(v))}</strong></td>
        <td>${efCell}</td>
        <td>${fmtMoney(v.total)}</td>
      </tr>`;
    }).join('');
  }
  const totalQr = ventas.reduce((s,v)=> s + qrMontoDeVenta(v), 0);
  const footer = document.getElementById('histQrFooter');
  if(footer){
    footer.innerHTML = `<td colspan="4" style="text-align:right; font-weight:700;">Total QR</td><td style="font-weight:800; color:var(--primary);">${fmtMoney(totalQr)}</td><td colspan="2"></td>`;
  }
  pintarBordeModal('modalQrHistorial', qrPersonaColor(persona));
  openModal('modalQrHistorial');
}

// Desde la ventana de características (pestaña Productos): abre la ventana de
// historial de ingresos del producto sin cambiar de pestaña.
function openProductIngresos(productId){
  const p = getProductoById(productId);
  if(!p) return;
  closeModalById('modalProductoDetalle');
  openCompraHistorial(p.codigo);
}

// Borra UNA compra. Al borrarla se pregunta si el inventario se mantiene:
//   mantenerInventario = true  → el stock NO se toca.
//   mantenerInventario = false → la cantidad comprada se quita del stock.
function deleteCompra(id, mantenerInventario){
  const compra = db.compras.find(c => c.id === id);
  if(!compra) return;
  if(!mantenerInventario){
    const p = getProductoByCodigo(compra.codigo);
    if(p){
      p.stock = (p.stock || 0) - compra.cantidad;
      touchProducto(p);
      applyStockDelta(p, -compra.cantidad); // quita la cantidad también en la nube
    }
  }
  db.compras = db.compras.filter(c => c.id !== id);
  saveDB();
  renderCompras();
  renderInventario();
  renderProductos();
  // Si la ventana de historial estaba abierta, la refresca (o la cierra si el
  // producto se quedó sin ingresos).
  const histModal = document.getElementById('modalCompraHistorial');
  if(histModal && histModal.classList.contains('open')){
    if(db.compras.some(c => c.codigo === compra.codigo)) openCompraHistorial(compra.codigo);
    else closeAllModals();
  }
  toast('Ingreso eliminado', 'success');
}

function vaciarHistorialCompras(){
  ventaBorrarDialog('Vaciar historial de ingresos', '¿Vaciar todo el historial de ingresos?\n\n¿Mantener el inventario?\n• Sí = el inventario NO se modifica.\n• No = las cantidades se quitan del stock.',
    ()=> vaciarComprasConStock(false),
    ()=> vaciarComprasConStock(true));
}
function vaciarComprasConStock(quitarStock){
  if(quitarStock){
    db.compras.forEach(c => {
      const p = getProductoByCodigo(c.codigo);
      if(p){
        p.stock = (p.stock || 0) - c.cantidad;
        touchProducto(p);
        applyStockDelta(p, -c.cantidad); // quita la cantidad también en la nube
      }
    });
  }
  db.compras = [];
  saveDB();
  renderCompras();
  renderInventario();
  renderProductos();
  toast('Historial de ingresos vaciado', 'success');
}

// Borra ingresos de hace más de 3 meses (el stock no se modifica).
function purgeComprasAntiguas(){
  const corte = new Date();
  corte.setDate(corte.getDate() - 90);
  const corteKey = localDateKey(corte);
  const antes = db.compras.length;
  db.compras = db.compras.filter(c => ventaFechaKey(c.fecha) >= corteKey);
  const borradas = antes - db.compras.length;
  saveDB();
  renderCompras();
  if(borradas > 0) toast(`${borradas} ingreso(s) antiguo(s) eliminados`, 'success');
  else toast('No había ingresos antiguos que borrar', 'warning');
}

// Recordatorio semanal de respaldo para las compras (independiente del de ventas).
const COMPRA_EXPORT_PROMPT_KEY = 'stockferre_export_compra_prompt_v1';
function getLastCompraExportPrompt(){
  try{ return localStorage.getItem(COMPRA_EXPORT_PROMPT_KEY) || ''; }catch(e){ return ''; }
}
function markCompraExportPrompt(){
  try{ localStorage.setItem(COMPRA_EXPORT_PROMPT_KEY, dateKeyOffset(0)); }catch(e){}
}
function maybeShowCompraReminder(){
  const el = document.getElementById('exportCompraReminder');
  if(!el) return;
  const last = getLastCompraExportPrompt();
  if(last && new Date() - new Date(last) < EXPORT_PROMPT_DAYS * 86400000){
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  el.innerHTML = `
    <span>💾 Hace más de una semana que no haces un respaldo de los ingresos. Es recomendable exportarlos para que el registro no crezca demasiado.</span>
    <button class="btn btn-secondary btn-sm" id="btnCompraExportNow">📤 Exportar ahora</button>
    <button class="btn btn-secondary btn-sm" id="btnCompraDismiss">Omitir</button>
  `;
}

function exportComprasCSV(){
  if(db.compras.length === 0){
    toast('No hay ingresos para exportar', 'error');
    return;
  }
  const header = ['FECHA','CODIGO','PRODUCTO','PROVEEDOR','CANTIDAD','PRECIO UNITARIO','TOTAL','METODO DE PAGO','OBSERVACIONES'];
  const rows = db.compras.map(c => [
    c.fecha, csvText(c.codigo), c.nombre, c.proveedor || '', csvNumber(c.cantidad), csvNumber(c.precioUnitario, 2), csvNumber(c.total, 2), c.metodoPago, c.observaciones || ''
  ]);
  downloadCSV(`stockferre_ingresos_${todayISO().slice(0,10)}.csv`, header, rows);
  toast('Ingresos exportados', 'success');
}

// Importa compras desde un CSV (un respaldo exportado antes). Se agregan como
// registros al historial de compras; NO modifica el stock (para no sumarlo
// dos veces si esa compra ya afectó el inventario al registrarse).
function importComprasCSV(file){
  const reader = new FileReader();
  reader.onload = (e)=>{
    try{
      const rows = parseCSV(e.target.result);
      if(rows.length < 2){
        toast('El archivo CSV no tiene datos', 'error');
        return;
      }
      const headers = rows[0].map(normalizeHeader);
      const idx = {
        fecha: headers.indexOf('FECHA'),
        codigo: headers.indexOf('CODIGO'),
        nombre: headers.findIndex(h => h.includes('PRODUCTO') || h.includes('DESCRIPCION')),
        proveedor: headers.indexOf('PROVEEDOR'),
        cantidad: headers.indexOf('CANTIDAD'),
        precioUnitario: headers.findIndex(h => h.includes('PRECIO') && h.includes('UNITARIO')),
        total: headers.indexOf('TOTAL'),
        metodoPago: headers.findIndex(h => h.includes('PAGO')),
        observaciones: headers.findIndex(h => h.includes('OBSERVACION') || h.includes('NOTA'))
      };
      if(idx.codigo === -1 || idx.nombre === -1 || idx.total === -1){
        toast('El CSV debe tener al menos columnas CODIGO, PRODUCTO y TOTAL', 'error');
        return;
      }
      let importadas = 0;
      for(let i = 1; i < rows.length; i++){
        const r = rows[i];
        const nombre = String(r[idx.nombre] || '').trim();
        if(!nombre) continue;
        const cantidad = idx.cantidad > -1 ? (parseFloat(String(r[idx.cantidad]).replace(',','.')) || 1) : 1;
        const total = parsePrecio(r[idx.total]);
        const precioUnitario = idx.precioUnitario > -1 ? parsePrecio(r[idx.precioUnitario]) : (cantidad > 0 ? total / cantidad : 0);
        const codigo = String(r[idx.codigo] || '').trim() || 'OTRO';
        const proveedor = idx.proveedor > -1 ? String(r[idx.proveedor] || '').trim() : '';
        const observaciones = idx.observaciones > -1 ? String(r[idx.observaciones] || '').trim() : '';
        const p = getProductoByCodigo(codigo);
        db.compras.push({
          id: uid('compra'),
          codigo,
          nombre,
          cantidad,
          precioUnitario,
          total,
          metodoPago: idx.metodoPago > -1 ? (String(r[idx.metodoPago]||'').toLowerCase().includes('qr') ? 'qr' : 'efectivo') : 'efectivo',
          fecha: idx.fecha > -1 ? (r[idx.fecha] || todayISO()) : todayISO(),
          proveedor,
          observaciones,
          productoId: p ? p.id : null
        });
        importadas++;
      }
      db.compras.sort((a,b)=> new Date(b.fecha) - new Date(a.fecha));
      saveDB();
      renderCompras();
      toast(`Ingresos importados: ${importadas} (no se modificó el stock)`, 'success');
    }catch(err){
      console.error(err);
      toast('No se pudo leer el archivo CSV. Verifica el formato.', 'error');
    }
  };
  reader.onerror = ()=> toast('Error al leer el archivo', 'error');
  reader.readAsText(file, 'UTF-8');
}

/* -------------------------------------------------------------------------
   4g. FINANZAS: ESTADO FINANCIERO / RETIROS / DEUDAS (solo dueño)
   ------------------------------------------------------------------------- */

// Capital del negocio = suma de (stock × precio de compra) de cada producto.
function capitalEnProductos(){
  return db.productos.reduce((sum, p) => sum + ((p.stock || 0) * (parseFloat(p.precioCompra) || 0)), 0);
}

function renderFinanzas(){
  const capEl = document.getElementById('finCapital');
  const cajaEl = document.getElementById('finCaja');
  const totEl = document.getElementById('finTotal');
  const deudaEl = document.getElementById('finDeuda');
  if(!capEl || !cajaEl || !totEl) return;
  const capital = capitalEnProductos();
  const caja = Number(db.finanzas.caja) || 0;
  capEl.textContent = fmtMoney(capital);
  cajaEl.textContent = fmtMoney(caja);
  totEl.textContent = fmtMoney(capital + caja);
  if(deudaEl) deudaEl.textContent = fmtMoney(deudaPendienteTotal());
}

function openEditarCajaModal(){
  document.getElementById('cajaMonto').value = Number(db.finanzas.caja) || 0;
  openModal('modalEditarCaja');
}

function handleEditarCajaSubmit(e){
  e.preventDefault();
  const monto = parseFloat(document.getElementById('cajaMonto').value);
  if(isNaN(monto) || monto < 0){ toast('Ingresa un monto válido', 'error'); return; }
  db.finanzas = db.finanzas || {};
  db.finanzas.caja = monto;
  saveDB();
  renderFinanzas();
  closeAllModals();
  toast('Efectivo actualizado', 'success');
}

function exportFinanzasCSV(){
  const capital = capitalEnProductos();
  const caja = Number(db.finanzas.caja) || 0;
  const header = ['FECHA','CONCEPTO','MONTO'];
  const rows = [
    [todayISO(), 'Capital en productos (stock x precio de compra)', csvNumber(capital, 2)],
    [todayISO(), 'Efectivo actual', csvNumber(caja, 2)],
    [todayISO(), 'Deuda pendiente (deudas - pagos)', csvNumber(deudaPendienteTotal(), 2)],
    [todayISO(), 'Patrimonio total (productos + efectivo)', csvNumber(capital + caja, 2)]
  ];
  downloadCSV(`stockferre_finanzas_${todayISO().slice(0,10)}.csv`, header, rows);
  toast('Estado financiero exportado', 'success');
}

/* ---------- RETIROS DE DINERO ---------- */
// La fecha del retiro se recuerda por modo (como en Compras) hasta que la cambien.
const RETIRO_FECHA_KEY = 'stockferre_retiro_fecha_v1_';
function getLastRetiroFecha(){
  try{
    const val = localStorage.getItem(RETIRO_FECHA_KEY + currentModo);
    return /^\d{4}-\d{2}-\d{2}$/.test(val) ? val : dateKeyOffset(0);
  }catch(e){ return dateKeyOffset(0); }
}
function setLastRetiroFecha(dateStr){
  try{ localStorage.setItem(RETIRO_FECHA_KEY + currentModo, dateStr || ''); }catch(e){}
}

// Filtro por mes en la vista de retiros: '' = todas, 'YYYY-MM' = ese mes.
let retiroMesFilter = '';
function retirosFiltrados(){
  const list = (db.finanzas.retiros || []).slice()
    .sort((a,b)=> new Date(b.fecha || 0) - new Date(a.fecha || 0));
  if(!retiroMesFilter) return list;
  return list.filter(r => (r.fecha || '').slice(0,7) === retiroMesFilter);
}
function syncRetiroMesFilter(){
  const el = document.getElementById('retirosMes');
  if(!el) return;
  const meses = [...new Set((db.finanzas.retiros || []).map(r => (r.fecha || '').slice(0,7)).filter(Boolean))].sort().reverse();
  let html = '<option value="">Todas las fechas</option>';
  meses.forEach(m => {
    const [y, mo] = m.split('-').map(Number);
    const nombre = new Date(y, mo-1, 1).toLocaleString('es', { month:'long' });
    const label = nombre.charAt(0).toUpperCase() + nombre.slice(1) + ' ' + y;
    html += `<option value="${m}" ${m === retiroMesFilter ? 'selected' : ''}>${label}</option>`;
  });
  el.innerHTML = html;
}

function renderRetiros(){
  const tbody = document.querySelector('#retirosTable tbody');
  const summary = document.getElementById('retirosSummary');
  if(!tbody || !summary) return;
  const list = retirosFiltrados();
  syncRetiroMesFilter();
  if(list.length === 0){
    tbody.innerHTML = `<tr class="empty-row"><td colspan="5">${retiroMesFilter ? 'No hay pagos en este mes.' : 'Todavía no registraste ningún pago.'}</td></tr>`;
    summary.textContent = '0 pagos';
    return;
  }
  tbody.innerHTML = list.map(r => `
    <tr>
      <td>${fmtDateShort(r.fecha)}</td>
      <td>${retiroMarca(r) ? `<strong>${escapeHtml(retiroMarca(r))}</strong>` : '-'}</td>
      <td><strong class="stock-negative">-${fmtMoney(r.monto)}</strong></td>
      <td>${escapeHtml(r.obs || '-')}</td>
      <td>
        <button class="btn-icon" title="Editar" data-edit-retiro="${r.id}">✏️</button>
        <button class="btn-icon" title="Eliminar" data-delete-retiro="${r.id}">🗑️</button>
      </td>
    </tr>
  `).join('');
  const total = list.reduce((s, r) => s + r.monto, 0);
  summary.textContent = `${list.length} pago${list.length === 1 ? '' : 's'} · total pagado ${fmtMoney(total)}`;
}

// Cuánto se ha pagado (en retiros) de la deuda de una marca.
function retirosPagadosMarca(marca){
  const key = normalize(marca);
  if(!key) return 0;
  return (db.finanzas.retiros || []).reduce((s, r) => normalize(retiroMarca(r)) === key ? s + r.monto : s, 0);
}

// Deuda total, pagado y saldo pendiente de cada marca: { marca: {deuda, pagado, saldo} }.
function deudaSaldos(){
  const res = {};
  (db.finanzas.deudas || []).forEach(d => {
    const m = String(d.marca || 'Otra').trim() || 'Otra';
    res[m] = res[m] || { deuda: 0, pagado: 0, saldo: 0 };
    res[m].deuda += d.monto;
  });
  Object.keys(res).forEach(m => {
    res[m].pagado = retirosPagadosMarca(m);
    res[m].saldo = res[m].deuda - res[m].pagado;
  });
  return res;
}

// Deuda total que queda por pagar (solo saldos positivos).
function deudaPendienteTotal(){
  const res = deudaSaldos();
  return Object.values(res).reduce((s, v) => s + (v.saldo > 0 ? v.saldo : 0), 0);
}

function openRetiroModal(retiro){
  document.getElementById('retiroModalTitle').textContent = retiro ? '✏️ Editar pago' : '➖ Nuevo pago';
  document.getElementById('rId').value = retiro ? retiro.id : '';
  document.getElementById('rMonto').value = retiro ? retiro.monto : '';
  document.getElementById('rFecha').value = retiro ? (retiro.fecha ? localDateKey(new Date(retiro.fecha)) : getLastRetiroFecha()) : getLastRetiroFecha();
  document.getElementById('rObs').value = retiro ? (retiro.obs || '') : '';
  const marca = retiro ? retiroMarca(retiro) : '';
  rebuildMarcaSelect('rMarca', marca, ['Salarios']);
  syncNuevaMarcaRow(document.getElementById('rMarca'), document.getElementById('rNuevaMarca'), document.getElementById('rNuevaMarcaRow'));
  openModal('modalRetiro');
}

function handleRetiroSubmit(e){
  e.preventDefault();
  const id = document.getElementById('rId').value;
  const monto = parseFloat(document.getElementById('rMonto').value);
  const obs = document.getElementById('rObs').value.trim();
  const marcaSel = document.getElementById('rMarca').value;
  const nuevaMarca = document.getElementById('rNuevaMarca').value.trim();
  const marca = marcaSel === '__nueva__' ? nuevaMarca : marcaSel;
  if(marcaSel === '__nueva__' && !marca){ toast('Escribe el nombre de la nueva marca', 'error'); return; }
  if(isNaN(monto) || monto <= 0){ toast('Ingresa un monto válido', 'error'); return; }
  const fechaElegida = document.getElementById('rFecha').value;
  setLastRetiroFecha(fechaElegida);

  db.finanzas = db.finanzas || {};
  db.finanzas.retiros = db.finanzas.retiros || [];
  db.finanzas.caja = Number(db.finanzas.caja) || 0;

  if(id){
    const r = db.finanzas.retiros.find(x => x.id === id);
    if(!r) return;
    const dif = monto - r.monto;
    r.monto = monto;
    r.obs = obs;
    r.marca = marca;
    r.fecha = compraFechaFromInput(fechaElegida);
    db.finanzas.caja -= dif;
  }else{
    db.finanzas.retiros.unshift({
      id: uid('retiro'),
      monto,
      obs,
      marca,
      fecha: compraFechaFromInput(fechaElegida)
    });
    db.finanzas.caja -= monto;
  }
  saveDB();
  renderRetiros();
  renderDeudas();
  renderFinanzas();
  closeAllModals();
  toast('Pago guardado', 'success');
}

function deleteRetiro(id){
  confirmDialog('Eliminar pago', '¿Eliminar este pago? El monto volverá al efectivo actual y a la deuda de su marca.', ()=>{
    const r = db.finanzas.retiros.find(x => x.id === id);
    if(!r) return;
    db.finanzas.caja = (Number(db.finanzas.caja) || 0) + r.monto;
    db.finanzas.retiros = db.finanzas.retiros.filter(x => x.id !== id);
    saveDB();
    renderRetiros();
    renderDeudas();
    renderFinanzas();
    toast('Pago eliminado', 'success');
  });
}

function exportRetirosCSV(){
  const list = db.finanzas.retiros || [];
  if(list.length === 0){ toast('No hay pagos para exportar', 'error'); return; }
  const header = ['FECHA','MONTO','MARCA','OBSERVACION'];
  const rows = list.map(r => [r.fecha, csvNumber(r.monto, 2), retiroMarca(r), r.obs || '']);
  downloadCSV(`stockferre_pagos_${todayISO().slice(0,10)}.csv`, header, rows);
  toast('Pagos exportados', 'success');
}

/* ---------- DEUDAS ---------- */
const DEUDA_FECHA_KEY = 'stockferre_deuda_fecha_v1_';
function getLastDeudaFecha(){
  try{
    const val = localStorage.getItem(DEUDA_FECHA_KEY + currentModo);
    return /^\d{4}-\d{2}-\d{2}$/.test(val) ? val : dateKeyOffset(0);
  }catch(e){ return dateKeyOffset(0); }
}
function setLastDeudaFecha(dateStr){
  try{ localStorage.setItem(DEUDA_FECHA_KEY + currentModo, dateStr || ''); }catch(e){}
}

// Marcas que siempre aparecen preseleccionadas en deudas y pagos.
const MARCAS_PREDEFINIDAS = ['Ingco','Truper','Dyllu'];

// Marca de un retiro para vincularlo a su deuda.
function retiroMarca(r){
  if(r && r.marca && String(r.marca).trim()) return String(r.marca).trim();
  const obs = String(r && r.obs || '').trim();
  const m = obs.match(/^pago\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

// Todas las marcas en uso (deudas + pagos), con las preseleccionadas primero.
function marcasExistentes(){
  const set = new Set();
  MARCAS_PREDEFINIDAS.forEach(m => set.add(m));
  (db.finanzas.deudas || []).forEach(d => { if(d.marca) set.add(String(d.marca).trim()); });
  (db.finanzas.retiros || []).forEach(r => { const m = retiroMarca(r); if(m && m !== 'Salarios') set.add(m); });
  return [...set];
}

// Llena el select de marca de un modal. 'valorActual' deja preseleccionada la
// marca al editar, y la opción "__nueva__" permite añadir una marca nueva.
function rebuildMarcaSelect(selectId, valorActual, extraOptions){
  const el = document.getElementById(selectId);
  if(!el) return;
  const set = new Set();
  marcasExistentes().forEach(m => set.add(m));
  (extraOptions || []).forEach(m => { if(m) set.add(m); });
  const marcas = [...set].sort((a,b)=> {
    const ia = MARCAS_PREDEFINIDAS.indexOf(a), ib = MARCAS_PREDEFINIDAS.indexOf(b);
    if(ia !== -1 && ib !== -1) return ia - ib;
    if(ia !== -1) return -1;
    if(ib !== -1) return 1;
    return a.localeCompare(b, 'es');
  });
  let html = marcas.map(m => `<option value="${escapeHtml(m)}" ${m === valorActual ? 'selected' : ''}>${escapeHtml(m)}</option>`).join('');
  html += '<option value="__nueva__">➕ Añadir nueva marca...</option>';
  el.innerHTML = html;
}

// Revela el campo de "Nueva marca" cuando se elige esa opción en un select.
function syncNuevaMarcaRow(selectEl, inputEl, rowEl){
  if(!selectEl || !inputEl || !rowEl) return;
  if(selectEl.value === '__nueva__'){
    rowEl.style.display = 'block';
    inputEl.focus();
  }else{
    rowEl.style.display = 'none';
    inputEl.value = '';
  }
}

// Filtro por mes en la vista de deudas: '' = todas, 'YYYY-MM' = ese mes.
let deudaMesFilter = '';
function deudasFiltradas(){
  const deudas = (db.finanzas.deudas || []).slice()
    .sort((a,b)=> new Date(b.fecha || 0) - new Date(a.fecha || 0));
  if(!deudaMesFilter) return deudas;
  return deudas.filter(d => (d.fecha || '').slice(0,7) === deudaMesFilter);
}
function syncDeudaMesFilter(){
  const el = document.getElementById('deudasMes');
  if(!el) return;
  const meses = [...new Set((db.finanzas.deudas || []).map(d => (d.fecha || '').slice(0,7)).filter(Boolean))].sort().reverse();
  let html = '<option value="">Todas las fechas</option>';
  meses.forEach(m => {
    const [y, mo] = m.split('-').map(Number);
    const nombre = new Date(y, mo-1, 1).toLocaleString('es', { month:'long' });
    const label = nombre.charAt(0).toUpperCase() + nombre.slice(1) + ' ' + y;
    html += `<option value="${m}" ${m === deudaMesFilter ? 'selected' : ''}>${label}</option>`;
  });
  el.innerHTML = html;
}

function renderDeudas(){
  const groups = document.getElementById('deudasGroups');
  const totalEl = document.getElementById('deudasTotal');
  if(!groups || !totalEl) return;
  const deudas = deudasFiltradas();
  syncDeudaMesFilter();

  const saldos = deudaSaldos();
  const sumDeuda = Object.values(saldos).reduce((s,v)=> s + v.deuda, 0);
  const sumPagado = Object.values(saldos).reduce((s,v)=> s + v.pagado, 0);
  const sumSaldo = Object.values(saldos).reduce((s,v)=> s + v.saldo, 0);

  if((db.finanzas.deudas || []).length === 0){
    groups.innerHTML = `<p class="hint">Todavía no registraste ninguna deuda. Al registrar una deuda, aparece su opción de "Pago" en los retiros.</p>`;
    totalEl.textContent = `Deudas: ${fmtMoney(0)} · Pagado: ${fmtMoney(0)} · Saldo: ${fmtMoney(0)}`;
    return;
  }
  if(deudas.length === 0){
    groups.innerHTML = `<p class="hint">No hay deudas en este mes.</p>`;
    totalEl.textContent = `Deudas: ${fmtMoney(sumDeuda)} · Pagado: ${fmtMoney(sumPagado)} · Saldo: ${fmtMoney(sumSaldo)}`;
    return;
  }

  const grupos = {};
  deudas.forEach(d => {
    const m = String(d.marca || 'Otra').trim() || 'Otra';
    (grupos[m] = grupos[m] || []).push(d);
  });
  const marcas = Object.keys(grupos).sort((a,b)=> a.localeCompare(b, 'es'));

  groups.innerHTML = marcas.map(marca => {
    const items = grupos[marca];
    const sd = saldos[marca] || { deuda: 0, pagado: 0, saldo: 0 };
    return `
    <div class="deuda-group">
      <div class="deuda-group-header">
        <div>
          <h3>🏷️ ${escapeHtml(marca)}</h3>
          <small class="hint">Deuda ${fmtMoney(sd.deuda)} · Pagado ${fmtMoney(sd.pagado)} · Saldo pendiente <strong>${fmtMoney(sd.saldo)}</strong>${sd.saldo <= 0 ? ' ✓' : ''}</small>
        </div>
        <strong>${fmtMoney(sd.saldo)}</strong>
      </div>
      <div class="table-wrap" style="box-shadow:none; border-radius:0;">
        <table class="table" style="min-width:0;">
          <thead><tr><th>Fecha</th><th>Vencimiento</th><th>Monto</th><th>Observación</th><th>Acciones</th></tr></thead>
          <tbody>
            ${items.map(d => `
              <tr>
                <td>${fmtDateShort(d.fecha)}</td>
                <td>${escapeHtml(d.vencimiento || '-')}</td>
                <td><strong>${fmtMoney(d.monto)}</strong></td>
                <td>${escapeHtml(d.obs || '-')}</td>
                <td>
                  <button class="btn-icon" title="Editar" data-edit-deuda="${d.id}">✏️</button>
                  <button class="btn-icon" title="Eliminar" data-delete-deuda="${d.id}">🗑️</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  }).join('');

  totalEl.textContent = `Deudas: ${fmtMoney(sumDeuda)} · Pagado: ${fmtMoney(sumPagado)} · Saldo: ${fmtMoney(sumSaldo)}`;
}

function openDeudaModal(deuda){
  document.getElementById('deudaModalTitle').textContent = deuda ? '✏️ Editar deuda' : '➕ Nueva deuda';
  document.getElementById('dId').value = deuda ? deuda.id : '';
  document.getElementById('dMonto').value = deuda ? deuda.monto : '';
  document.getElementById('dFecha').value = deuda ? (deuda.fecha ? localDateKey(new Date(deuda.fecha)) : getLastDeudaFecha()) : getLastDeudaFecha();
  document.getElementById('dVencimiento').value = deuda ? (deuda.vencimiento || '') : '';
  document.getElementById('dObs').value = deuda ? (deuda.obs || '') : '';
  const marca = deuda ? (deuda.marca || '') : '';
  rebuildMarcaSelect('dMarca', marca, []);
  syncNuevaMarcaRow(document.getElementById('dMarca'), document.getElementById('dNuevaMarca'), document.getElementById('dNuevaMarcaRow'));
  openModal('modalDeuda');
}

function handleDeudaSubmit(e){
  e.preventDefault();
  const id = document.getElementById('dId').value;
  const marcaSel = document.getElementById('dMarca').value;
  const nuevaMarca = document.getElementById('dNuevaMarca').value.trim();
  const marca = marcaSel === '__nueva__' ? nuevaMarca : marcaSel;
  const monto = parseFloat(document.getElementById('dMonto').value);
  const obs = document.getElementById('dObs').value.trim();
  const vencimiento = document.getElementById('dVencimiento').value;
  if(!marca){ toast('Ingresa la marca', 'error'); return; }
  if(isNaN(monto) || monto <= 0){ toast('Ingresa un monto válido', 'error'); return; }
  const fechaElegida = document.getElementById('dFecha').value;
  setLastDeudaFecha(fechaElegida);

  db.finanzas = db.finanzas || {};
  db.finanzas.deudas = db.finanzas.deudas || [];

  if(id){
    const d = db.finanzas.deudas.find(x => x.id === id);
    if(!d) return;
    d.marca = marca;
    d.monto = monto;
    d.obs = obs;
    d.fecha = compraFechaFromInput(fechaElegida);
    d.vencimiento = vencimiento;
  }else{
    db.finanzas.deudas.unshift({
      id: uid('deuda'),
      marca,
      monto,
      obs,
      fecha: compraFechaFromInput(fechaElegida),
      vencimiento,
      registradoEn: todayISO()
    });
  }
  saveDB();
  renderDeudas();
  closeAllModals();
  toast('Deuda guardada', 'success');
}

function deleteDeuda(id){
  confirmDialog('Eliminar deuda', '¿Eliminar esta deuda?', ()=>{
    db.finanzas.deudas = db.finanzas.deudas.filter(x => x.id !== id);
    saveDB();
    renderDeudas();
    toast('Deuda eliminada', 'success');
  });
}

function exportDeudasCSV(){
  const list = db.finanzas.deudas || [];
  if(list.length === 0){ toast('No hay deudas para exportar', 'error'); return; }
  const header = ['FECHA','MARCA','MONTO','VENCIMIENTO','OBSERVACION'];
  const rows = list.map(d => [d.fecha, d.marca || '', csvNumber(d.monto, 2), d.vencimiento || '', d.obs || '']);
  downloadCSV(`stockferre_deudas_${todayISO().slice(0,10)}.csv`, header, rows);
  toast('Deudas exportadas', 'success');
}

/* ---------- GASTOS DEL DÍA (solo dueño) ---------- */
// Cada gasto guarda fecha y hora, cantidad, precio (Bs) y observación.
// Total de un gasto = cantidad × Bs. La vista agrupa por día y suma cada día.
const GASTO_FECHA_KEY = 'stockferre_gasto_fecha_v1_';
function getLastGastoFecha(){
  try{
    const val = localStorage.getItem(GASTO_FECHA_KEY + currentModo);
    return /^\d{4}-\d{2}-\d{2}$/.test(val) ? val : dateKeyOffset(0);
  }catch(e){ return dateKeyOffset(0); }
}
function setLastGastoFecha(dateStr){
  try{ localStorage.setItem(GASTO_FECHA_KEY + currentModo, dateStr || ''); }catch(e){}
}
function horaNow(){
  const d = new Date();
  return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}
function horaKey(d){
  return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}
// Combina la fecha y la hora elegidas en un ISO que conserva ese momento local.
function gastoFechaFromInput(dateStr, horaStr){
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds());
  if(/^\d{4}-\d{2}-\d{2}$/.test(dateStr)){
    const parts = dateStr.split('-').map(Number);
    d.setFullYear(parts[0], parts[1]-1, parts[2]);
  }
  if(/^\d{2}:\d{2}$/.test(horaStr)){
    const hm = horaStr.split(':').map(Number);
    d.setHours(hm[0], hm[1], 0, 0);
  }
  return new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString();
}
function fmtFechaBonita(key){
  try{
    const [y,m,d] = key.split('-').map(Number);
    const str = new Date(y, m-1, d).toLocaleDateString('es-BO', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
    return str.charAt(0).toUpperCase() + str.slice(1);
  }catch(e){ return key; }
}

function renderGastos(){
  const tbody = document.querySelector('#gastosTable tbody');
  const summary = document.getElementById('gastosSummary');
  if(!tbody || !summary) return;
  const list = (db.gastos || []).slice()
    .sort((a,b)=> new Date(b.fecha || 0) - new Date(a.fecha || 0));
  if(list.length === 0){
    tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Todavía no registraste ningún gasto.</td></tr>`;
    summary.textContent = '0 gastos';
    return;
  }
  const grupos = {};
  list.forEach(g => {
    const k = ventaFechaKey(g.fecha);
    (grupos[k] = grupos[k] || []).push(g);
  });
  const dias = Object.keys(grupos).sort().reverse();
  let html = '';
  dias.forEach(dia => {
    const items = grupos[dia];
    const diaTotal = items.reduce((s,g)=> s + g.total, 0);
    html += `<tr class="gasto-day-row"><td colspan="6">📅 ${fmtFechaBonita(dia)} · <strong>${fmtMoney(diaTotal)}</strong></td></tr>`;
    html += items.map(g => `
      <tr>
        <td>${fmtHistoryDate(g.fecha)}</td>
        <td>${g.cantidad}</td>
        <td>${fmtMoney(g.bs)}</td>
        <td><strong>${fmtMoney(g.total)}</strong></td>
        <td>${escapeHtml(g.obs || '-')}</td>
        <td>
          <button class="btn-icon" title="Editar" data-edit-gasto="${g.id}">✏️</button>
          <button class="btn-icon" title="Eliminar" data-delete-gasto="${g.id}">🗑️</button>
        </td>
      </tr>`).join('');
  });
  tbody.innerHTML = html;
  const totalGeneral = list.reduce((s,g)=> s + g.total, 0);
  summary.textContent = `${list.length} gasto${list.length === 1 ? '' : 's'} · total ${fmtMoney(totalGeneral)}`;
}

function recalcGastoTotal(){
  const cant = parseFloat(document.getElementById('gCant').value) || 0;
  const bs = parseFloat(document.getElementById('gBs').value) || 0;
  document.getElementById('gTotalHint').textContent = `Total: ${fmtMoney(cant * bs)}`;
}

function openGastoModal(gasto){
  document.getElementById('gastoModalTitle').textContent = gasto ? '✏️ Editar gasto' : '🧾 Nuevo gasto';
  document.getElementById('gId').value = gasto ? gasto.id : '';
  document.getElementById('gCant').value = gasto ? gasto.cantidad : 1;
  document.getElementById('gBs').value = gasto ? gasto.bs : '';
  document.getElementById('gObs').value = gasto ? (gasto.obs || '') : '';
  document.getElementById('gFecha').value = gasto ? (gasto.fecha ? localDateKey(new Date(gasto.fecha)) : getLastGastoFecha()) : getLastGastoFecha();
  document.getElementById('gHora').value = gasto ? horaKey(new Date(gasto.fecha)) : horaNow();
  recalcGastoTotal();
  openModal('modalGasto');
}

function handleGastoSubmit(e){
  e.preventDefault();
  const id = document.getElementById('gId').value;
  const cant = parseFloat(document.getElementById('gCant').value);
  const bs = parseFloat(document.getElementById('gBs').value);
  const obs = document.getElementById('gObs').value.trim();
  const fecha = document.getElementById('gFecha').value;
  const hora = document.getElementById('gHora').value;
  if(isNaN(cant) || cant <= 0){ toast('Ingresa una cantidad válida', 'error'); return; }
  if(isNaN(bs) || bs <= 0){ toast('Ingresa un precio válido', 'error'); return; }
  const total = cant * bs;
  const fechaISO = gastoFechaFromInput(fecha, hora);
  db.gastos = db.gastos || [];
  if(id){
    const g = db.gastos.find(x => x.id === id);
    if(!g) return;
    g.cantidad = cant;
    g.bs = bs;
    g.total = total;
    g.obs = obs;
    g.fecha = fechaISO;
  }else{
    db.gastos.unshift({ id: uid('gasto'), cantidad: cant, bs, total, obs, fecha: fechaISO });
  }
  setLastGastoFecha(fecha);
  saveDB();
  renderGastos();
  closeAllModals();
  toast('Gasto guardado', 'success');
}

function deleteGasto(id){
  confirmDialog('Eliminar gasto', '¿Eliminar este gasto?', ()=>{
    db.gastos = (db.gastos || []).filter(x => x.id !== id);
    saveDB();
    renderGastos();
    toast('Gasto eliminado', 'success');
  });
}

/* -------------------------------------------------------------------------
   4c. INVENTARIO (stock por producto, escaneo de cantidades, export CSV)
   ------------------------------------------------------------------------- */

function renderInventario(){
  const tbody = document.querySelector('#inventarioTable tbody');
  if(db.productos.length === 0){
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">Todavía no hay productos.</td></tr>`;
    return;
  }

  const search = normalize(document.getElementById('invSearch').value);
  let list = db.productos.slice();
  if(search){
    list = list.filter(p =>
      normalize(p.nombre).includes(search) ||
      normalize(p.codigo).includes(search) ||
      normalize(p.codigoBarras).includes(search)
    );
  }
  list.sort((a,b)=>{
    // Los productos registrados en inventario en ESTE dispositivo aparecen
    // primero (los más recientes arriba); el stock se sincroniza igual en
    // todos los dispositivos desde la nube, sin importar el orden local.
    const da = invUpdates[a.id] || '';
    const db = invUpdates[b.id] || '';
    if(da !== db) return da > db ? -1 : 1;
    return a.nombre.localeCompare(b.nombre, 'es');
  });

  if(list.length === 0){
    tbody.innerHTML = `<tr class="empty-row"><td colspan="7">No hay productos que coincidan.</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(p => {
    const stock = p.stock || 0;
    const ultima = invUpdates[p.id] ? fmtHistoryDate(invUpdates[p.id]) : '-';
    return `
    <tr>
      <td><strong>${escapeHtml(p.codigo)}</strong></td>
      <td>${escapeHtml(p.codigoBarras || '-')}</td>
      <td>${escapeHtml(p.nombre)}</td>
      <td>${p.categoria ? `<span class="badge badge-muted">${escapeHtml(p.categoria)}</span>` : '-'}</td>
      <td><strong class="${stock < 0 ? 'stock-negative' : ''}">${stock}</strong></td>
      <td>${ultima}</td>
      <td><button class="btn-icon" title="Editar" data-edit-inventario="${p.id}">✏️</button></td>
    </tr>
  `;
  }).join('');
}

/* -------------------------------------------------------------------------
   4c-bis. EDITAR INVENTARIO (corregir stock y código de barras a mano)
   ------------------------------------------------------------------------- */

function openEditarInventarioModal(producto){
  document.getElementById('eInvId').value = producto.id;
  document.getElementById('eInvNombreDisplay').textContent = producto.nombre;
  document.getElementById('eInvStock').value = producto.stock || 0;
  document.getElementById('eInvCodigoBarras').value = producto.codigoBarras || '';
  openModal('modalEditarInventario');
}

function handleEditarInventarioSubmit(e){
  e.preventDefault();
  const id = document.getElementById('eInvId').value;
  const p = getProductoById(id);
  if(!p) return;

  const stockVal = parseFloat(document.getElementById('eInvStock').value);
  if(isNaN(stockVal)){
    toast('Ingresa una cantidad de stock válida', 'error');
    return;
  }

  const stockAnterior = p.stock || 0;
  p.stock = stockVal; // se permite negativo, no se bloquea
  p.codigoBarras = document.getElementById('eInvCodigoBarras').value.trim();
  touchProducto(p);
  markInventarioActualizado(p.id);
  logInventarioHistorial(p, stockVal - stockAnterior, 'ajuste manual');
  saveDB();
  applyStockAbsolute(p, stockVal); // el stock exacto se guarda también en la nube
  renderInventario();
  renderProductos();
  closeAllModals();
  toast('Inventario actualizado', 'success');
}

// Mueve el bloque real del escáner (cámara, worker, botones) dentro de un
// contenedor destino, sin duplicar ni reiniciar nada — así "el escáner mismo"
// funciona igual en la pestaña Escanear y en el registro de inventario.
function moveScannerBlockTo(containerId){
  const block = document.getElementById('scannerBlock');
  const container = document.getElementById(containerId);
  if(block && container) container.appendChild(block);
}
function restoreScannerBlockHome(){
  const block = document.getElementById('scannerBlock');
  const home = document.getElementById('scannerBlockHome');
  if(block && home) home.appendChild(block);
}

function openInventarioScan(){
  scanContext = 'inventario';
  moveScannerBlockTo('scannerBlockPlaceholder');
  document.getElementById('invScanResultBox').innerHTML = '';
  openModal('modalInventarioScan');
  if(!ocrActive && !zxingLiveActive) startActiveScanner();
}

function closeInventarioScan(){
  stopActiveScanner();
  restoreScannerBlockHome();
  closeAllModals();
}

// Al detectar un código en la pestaña de Inventario se abre directamente el
// recuadro de cantidad: muestra el código y la descripción del producto, con
// una tabla de números 1-6 para registrar rápido y un botón "Más" para
// escribir una cantidad distinta con el teclado.
function handleInventoryScan(codigo){
  const p = getProductoByCodigo(codigo);
  const box = document.getElementById('invScanResultBox');
  if(!p){
    if(box) box.innerHTML = `<div class="scan-not-found">⚠️ No se encontró ningún producto con el código <strong>${escapeHtml(codigo)}</strong>.</div>`;
    toast('Producto no encontrado', 'error');
    return;
  }
  if(box) box.innerHTML = '';
  openInventarioCantidadBox(p, codigo);
}

// Abre el recuadro de "Registrar inventario" ya con la descripción del
// producto lista. Se puede registrar con los botones 1-6 (registro inmediato)
// o tocar "Más" para escribir una cantidad con el teclado y luego "Registrar".
function openInventarioCantidadBox(producto, codigo){
  document.getElementById('invCodigo').value = codigo;
  document.getElementById('invCodigoDisplay').textContent = codigo;
  document.getElementById('invNombreDisplay').textContent = producto.nombre;
  document.getElementById('invStockActualDisplay').textContent = `Stock actual: ${producto.stock || 0}`;
  document.getElementById('invCantidad').value = 1;
  document.getElementById('invMasBox').style.display = 'none';
  openModal('modalInventarioDetalle');
}

function registrarInventarioCantidad(cantidad){
  const codigo = document.getElementById('invCodigo').value;
  const p = getProductoByCodigo(codigo);
  if(!p) return;

  if(!cantidad || cantidad <= 0){
    toast('Ingresa una cantidad válida', 'error');
    return;
  }

  p.stock = (p.stock || 0) + cantidad;
  touchProducto(p);
  markInventarioActualizado(p.id);
  logInventarioHistorial(p, cantidad, 'registro (escáner)');
  saveDB();
  applyStockDelta(p, cantidad); // la suma se aplica TAMBIÉN en la nube, atómica
  renderInventario();
  renderProductos();
  closeAllModals();
  toast(`Stock actualizado: ${p.nombre} → ${p.stock}`, 'success');

  // Sigue escaneando el siguiente producto sin que el usuario tenga que
  // volver a tocar el botón (pensado para hacer un conteo físico seguido)
  openInventarioScan();
}

function handleInventarioSubmit(e){
  e.preventDefault();
  const cantidad = parseFloat(document.getElementById('invCantidad').value);
  registrarInventarioCantidad(cantidad);
}

/* -------------------------------------------------------------------------
   4f. REGISTRO DE COMPRA (escáner + modal de cantidad/precios)
   ------------------------------------------------------------------------- */

function openCompraScan(){
  scanContext = 'compra';
  moveScannerBlockTo('compraScannerBlockPlaceholder');
  document.getElementById('compraScanResultBox').innerHTML = '';
  const manualInput = document.getElementById('manualCodeInput');
  if(manualInput) manualInput.value = '';
  openModal('modalCompraScan');
  if(!ocrActive && !zxingLiveActive) startActiveScanner();
}

function closeCompraScan(){
  stopActiveScanner();
  restoreScannerBlockHome();
  closeAllModals();
}

// Al detectar un código (escaneado con la cámara o escrito a mano) en la
// pestaña de Ingresos, se va DIRECTAMENTE al formulario "Registrar ingreso"
// sin pasar por la tarjeta de resultado: se cierra el escáner y se abre el
// formulario ya con la descripción, el último proveedor y la fecha elegida.
function handleCompraScan(codigo){
  const p = getProductoByCodigo(codigo);
  closeCompraScan();
  openCompraDetalleForm(p, codigo);
}

// Abre el recuadro "Registrar compra". Si el producto NO existe (producto==null)
// se creará al guardar; en ese caso siempre se guardan marca y precio de venta.
function openCompraDetalleForm(producto, codigo){
  const esNuevo = !producto;
  document.getElementById('cCodigo').value = codigo;
  document.getElementById('cNombreInput').value = producto ? producto.nombre : '';
  document.getElementById('cNombreDisplay').textContent = producto ? producto.nombre : 'Producto nuevo (se creará al guardar)';
  document.getElementById('cCantidad').value = 1;
  document.getElementById('cPrecioCompra').value = producto ? (producto.precioCompra || '') : '';
  document.getElementById('cProveedor').value = getLastCompraProveedor();
  document.getElementById('cObservaciones').value = '';
  document.getElementById('cFecha').value = getLastCompraFecha();
  document.getElementById('cMarca').value = producto ? (producto.marca || '') : '';
  document.getElementById('cPrecioVenta').value = producto ? (producto.precioVenta || '') : '';
  document.getElementById('cActualizarDatos').checked = false;
  // Producto nuevo → la casilla no hace falta: siempre se guardan los datos.
  document.getElementById('compraUpdateToggle').style.display = esNuevo ? 'none' : 'flex';
  document.getElementById('compraUpdateFields').style.display = esNuevo ? 'grid' : 'none';
  recalcCompraTotal();
  openModal('modalCompraDetalle');
}

function recalcCompraTotal(){
  const cant = parseFloat(document.getElementById('cCantidad').value) || 0;
  const pre = parseFloat(document.getElementById('cPrecioCompra').value) || 0;
  document.getElementById('cTotalDisplay').value = (cant * pre).toFixed(2);
}

// Convierte la fecha elegida en el recuadro ("YYYY-MM-DD", por defecto hoy)
// a un valor ISO que conserva ese día en la zona horaria del dispositivo,
// igual que lo hacen las ventas con todayISO(). Si no hay fecha, usa ahora.
function compraFechaFromInput(dateStr){
  if(!dateStr) return todayISO();
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds());
  if(/^\d{4}-\d{2}-\d{2}$/.test(dateStr)){
    const parts = dateStr.split('-').map(Number);
    d.setFullYear(parts[0], parts[1] - 1, parts[2]);
  }
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString();
}

// La fecha de compra elegida se recuerda por modo (este dispositivo) y se
// mantiene entre una compra y otra hasta que la vuelvan a cambiar. Así, si
// estás registrando varios recibos de ayer, no tienes que volver a elegirla.
const COMPRA_FECHA_KEY = 'stockferre_compra_fecha_v1_';
function getLastCompraFecha(){
  try{
    const val = localStorage.getItem(COMPRA_FECHA_KEY + currentModo);
    return /^\d{4}-\d{2}-\d{2}$/.test(val) ? val : dateKeyOffset(0);
  }catch(e){ return dateKeyOffset(0); }
}
function setLastCompraFecha(dateStr){
  try{ localStorage.setItem(COMPRA_FECHA_KEY + currentModo, dateStr || ''); }catch(e){}
}

// El último proveedor usado se recuerda por modo (como la fecha) para agilizar
// el registro de varios recibos seguidos del mismo distribuidor.
const COMPRA_PROVEEDOR_KEY = 'stockferre_compra_proveedor_v1_';
function getLastCompraProveedor(){
  try{ return localStorage.getItem(COMPRA_PROVEEDOR_KEY + currentModo) || ''; }catch(e){ return ''; }
}
function setLastCompraProveedor(val){
  try{ localStorage.setItem(COMPRA_PROVEEDOR_KEY + currentModo, val || ''); }catch(e){}
}

function handleCompraSubmit(e){
  e.preventDefault();
  const codigo = document.getElementById('cCodigo').value.trim();
  const nombre = document.getElementById('cNombreInput').value.trim();
  const cantidad = parseFloat(document.getElementById('cCantidad').value);
  const precioCompra = parseFloat(document.getElementById('cPrecioCompra').value);

  if(!codigo || !nombre){
    toast('Ingresa el código y la descripción', 'error');
    return;
  }
  if(!cantidad || cantidad <= 0){
    toast('Ingresa una cantidad válida', 'error');
    return;
  }
  if(isNaN(precioCompra) || precioCompra < 0){
    toast('Ingresa un precio de compra válido', 'error');
    return;
  }

  const actualizar = document.getElementById('cActualizarDatos').checked;
  const marca = document.getElementById('cMarca').value.trim();
  const precioVenta = parseFloat(document.getElementById('cPrecioVenta').value);

  let p = getProductoByCodigo(codigo);
  const esNuevo = !p;
  if(esNuevo){
    p = {
      id: uid('producto'),
      codigo,
      nombre,
      marca,
      categoria: '',
      codigoBarras: '',
      precioCompra,
      precioMarca: 0,
      precioVenta: !isNaN(precioVenta) && precioVenta >= 0 ? precioVenta : 0,
      stock: 0,
      fechaCreacion: todayISO(),
      _updatedAt: Date.now()
    };
    db.productos.push(p);
    syncProductoDoc(p); // el producto nuevo también tiene documento en la nube
  }

  p.stock = (p.stock || 0) + cantidad;

  // Opcional: actualiza los datos del producto (marca y precios). Las ventas
  // ya registradas guardan su propio precio, así que NO cambian.
  if(esNuevo || actualizar){
    if(marca) p.marca = marca;
    p.precioCompra = precioCompra;
    if(!isNaN(precioVenta) && precioVenta >= 0) p.precioVenta = precioVenta;
    if(!esNuevo) syncProductoDoc(p); // datos actualizados también en la nube
  }
  touchProducto(p);

  const fechaElegida = document.getElementById('cFecha').value;
  setLastCompraFecha(fechaElegida);
  const proveedor = document.getElementById('cProveedor').value.trim();
  const observaciones = document.getElementById('cObservaciones').value.trim();
  setLastCompraProveedor(proveedor);
  db.compras.unshift({
    id: uid('compra'),
    codigo,
    nombre,
    cantidad,
    precioUnitario: precioCompra,
    total: precioCompra * cantidad,
    metodoPago: document.getElementById('cMetodoPago').value,
    fecha: compraFechaFromInput(fechaElegida),
    proveedor,
    observaciones,
    productoId: p.id
  });
  db.compras.sort((a,b)=> new Date(b.fecha) - new Date(a.fecha));

  logInventarioHistorial(p, cantidad, 'compra');
  saveDB();
  applyStockDelta(p, cantidad); // la compra suma stock TAMBIÉN en la nube, atómica
  renderCompras();
  renderInventario();
  renderProductos();
  closeAllModals();
  toast(`Ingreso registrado: ${nombre} → stock ${p.stock}`, 'success');

  // Sigue escaneando el siguiente producto para registrar más compras seguido
  openCompraScan();
}

/* -------------------------------------------------------------------------
   4d. NUEVA VENTA (buscar producto existente o vender algo "OTRO")
   ------------------------------------------------------------------------- */

function openVentaScan(){
  scanContext = 'venta';
  moveScannerBlockTo('ventaScannerBlockPlaceholder');
  document.getElementById('ventaScanResultBox').innerHTML = '';
  const manualInput = document.getElementById('manualCodeInput');
  if(manualInput) manualInput.value = '';
  openModal('modalVentaScan');
  if(!ocrActive && !zxingLiveActive) startActiveScanner();
}

function closeVentaScan(){
  stopActiveScanner();
  restoreScannerBlockHome();
  closeAllModals();
}

// Al detectar un código en "Nueva venta": si el producto existe se cierra el
// escáner y se abre directo el formulario de venta con ese producto. Si no
// existe, se avisa en el propio escáner y se puede seguir escaneando.
function handleVentaScan(codigo){
  const p = getProductoByCodigo(codigo);
  if(!p){
    const box = document.getElementById('ventaScanResultBox');
    if(box) box.innerHTML = `<p class="hint" style="margin:0;">No se encontró el código <strong>${escapeHtml(codigo)}</strong>. Verificá que esté bien escrito o escaneá de nuevo. Si el producto no está en el inventario, usá "OTRO".</p>`;
    toast('Producto no encontrado', 'error');
    return;
  }
  closeVentaScan();
  openVentaModal(p);
}

/* -------------------------------------------------------------------------
   AÑADIR CÓDIGO DE BARRAS (solo modo pro)
   Pestaña parecida a "Escanear" pero SIN el modo de escáner de código de
   barras. El flujo tiene DOS pasos, todo automático:
     1º  Se escanea el CÓDIGO del producto (numérico o alfanumérico). Si
         existe, se muestra el código y la descripción con claridad y la
         cámara pasa SOLA al modo de código de barras.
     2º  Se escanea el código de barras físico del producto y se guarda (o
         cambia) en el producto. Luego vuelve al modo numérico para poder
         continuar con otro producto.
   ------------------------------------------------------------------------- */

// Producto al que se le va a guardar el código de barras (null = aún no se
// identificó ningún producto en esta sesión de la pestaña).
let barcodePendingProduct = null;

function openCodigoBarrasView(){
  scanContext = 'codigobarras';
  barcodePendingProduct = null;
  moveScannerBlockTo('codigoBarrasScannerPlaceholder');
  // En esta pestaña el escáner de código de barras NO aparece como botón:
  // solo se usa automáticamente después de identificar el producto.
  const cbTab = document.querySelector('[data-scan-code-mode="codigobarras"]');
  if(cbTab) cbTab.style.display = 'none';
  const box = document.getElementById('codigoBarrasResult');
  if(box) box.innerHTML = '';
  setScanCodeMode('numerico').finally(()=>{
    if(!ocrActive && !zxingLiveActive) startActiveScanner();
  });
}

function handleCodigoBarrasScan(codigo, fromCamera){
  const box = document.getElementById('codigoBarrasResult');
  if(!box) return;

  if(!barcodePendingProduct){
    // PASO 1: identificar el producto por su código interno.
    const p = getProductoByCodigo(codigo);
    if(!p){
      box.innerHTML = `<div class="scan-not-found">⚠️ No se encontró ningún producto con el código <strong>${escapeHtml(codigo)}</strong>. Verificá que esté bien escrito o escaneá de nuevo.</div>`;
      toast('Producto no encontrado', 'error');
      return;
    }
    barcodePendingProduct = p;
    box.innerHTML = `
      <div class="scan-result-card">
        <h4>📦 ${escapeHtml(p.nombre)}</h4>
        <div class="sr-row"><span>Código</span><strong>${escapeHtml(p.codigo)}</strong></div>
        <div class="sr-row"><span>Código de barras actual</span><strong>${escapeHtml(p.codigoBarras || '-')}</strong></div>
        <p class="hint" style="margin:10px 0 0;">📷 Ahora escaneá el <strong>código de barras</strong> de este producto: la cámara ya cambió sola y se guardará automáticamente.</p>
      </div>`;
    // Pasa sola al escáner de código de barras.
    setScanCodeMode('codigobarras').finally(()=>{
      if(!ocrActive && !zxingLiveActive) startActiveScanner();
    });
    if(fromCamera) scrollToScanResult('codigoBarrasResult');
    return;
  }

  // PASO 2: se detectó el código de barras → se guarda en el producto.
  const p = barcodePendingProduct;
  barcodePendingProduct = null;
  p.codigoBarras = codigo;
  touchProducto(p);
  saveDB();
  syncProductoDoc(p); // mantiene el documento del producto en la nube al día
  box.innerHTML = `
    <div class="scan-result-card">
      <h4>✅ Código de barras guardado</h4>
      <div class="sr-row"><span>Producto</span><strong>${escapeHtml(p.nombre)}</strong></div>
      <div class="sr-row"><span>Código</span><strong>${escapeHtml(p.codigo)}</strong></div>
      <div class="sr-row"><span>Código de barras</span><strong>${escapeHtml(codigo)}</strong></div>
      <p class="hint" style="margin:10px 0 0;">Volvió al modo numérico: ya podés escanear el código de otro producto.</p>
    </div>`;
  // Vuelve al modo numérico para escanear el siguiente producto.
  setScanCodeMode('numerico').finally(()=>{
    if(!ocrActive && !zxingLiveActive) startActiveScanner();
  });
  if(fromCamera) scrollToScanResult('codigoBarrasResult');
  toast('Código de barras guardado', 'success');
}

function openNuevaVentaModal(){
  document.getElementById('ventaSearchInput').value = '';
  renderVentaSearchResults();
  openModal('modalNuevaVenta');
  setTimeout(()=> document.getElementById('ventaSearchInput').focus(), 50);
}

function renderVentaSearchResults(){
  const search = normalize(document.getElementById('ventaSearchInput').value);
  const container = document.getElementById('ventaSearchResults');

  let list = db.productos.slice();
  if(search){
    list = list.filter(p =>
      normalize(p.nombre).includes(search) ||
      normalize(p.codigo).includes(search)
    );
  }
  list.sort((a,b)=> a.nombre.localeCompare(b.nombre, 'es'));
  list = list.slice(0, 30); // límite razonable para no saturar la lista

  if(list.length === 0){
    container.innerHTML = `<p class="hint" style="margin:0 0 8px;">No se encontró ningún producto. Usa "OTRO" para vender algo que no está en tu inventario.</p>`;
    return;
  }
  container.innerHTML = list.map(p => `
    <button type="button" class="venta-search-item" data-venta-select="${p.id}">
      <span class="vsi-nombre">${escapeHtml(p.nombre)}</span>
      <span class="vsi-meta">${escapeHtml(p.codigo)} · ${fmtMoney(p.precioVenta)}</span>
    </button>
  `).join('');
}

// "Nuevo ingreso" abre la misma ventana de búsqueda que "Nueva venta", con su
// botón de escáner y el buscador por nombre/código. Al elegir un producto se
// abre el formulario de registro del ingreso.
function openNuevaCompraModal(){
  document.getElementById('compraSearchInput').value = '';
  renderCompraSearchResults();
  openModal('modalNuevaCompra');
  setTimeout(()=> document.getElementById('compraSearchInput').focus(), 50);
}

function renderCompraSearchResults(){
  const container = document.getElementById('compraSearchResults');
  if(!container) return;
  const search = normalize(document.getElementById('compraSearchInput').value);

  let list = db.productos.slice();
  if(search){
    list = list.filter(p =>
      normalize(p.nombre).includes(search) ||
      normalize(p.codigo).includes(search)
    );
  }
  list.sort((a,b)=> a.nombre.localeCompare(b.nombre, 'es'));
  list = list.slice(0, 30);

  if(list.length === 0){
    container.innerHTML = `<p class="hint" style="margin:0 0 8px;">No se encontró ningún producto. Escanea un código nuevo y el producto se creará al registrar el ingreso.</p>`;
    return;
  }
  container.innerHTML = list.map(p => `
    <button type="button" class="venta-search-item" data-compra-select="${p.id}">
      <span class="vsi-nombre">${escapeHtml(p.nombre)}</span>
      <span class="vsi-meta">${escapeHtml(p.codigo)} · Compra ${fmtMoney(p.precioCompra)}</span>
    </button>
  `).join('');
}

const csvEscapeField = v => {
  v = String(v ?? '');
  // Protección contra inyección de fórmulas: si el texto empieza con =, +, -,
  // @ o tabulador, Excel lo interpreta como fórmula. Se antepone un apóstrofo
  // para que Excel lo trate como texto plano.
  if(/^[=+\-@\t]/.test(v)) v = "'" + v;
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g,'""') + '"' : v;
};

// Fuerza a Excel a tratar un campo como TEXTO anteponiendo un apóstrofo.
// Sin esto, una columna con códigos mezclados (números como 12399 y
// alfanuméricos como ABG031.1) hace que Excel detecte la columna como número
// y marque como "errores" los alfanuméricos (los productos INGCO salen "sin
// código"). Con el apóstrofo Excel muestra el código limpio como texto.
// Al re-importar, parseCSV quita el apóstrofo, así los códigos no se corrompen.
const csvText = v => {
  v = String(v ?? '');
  return v ? "'" + v : '';
};

// Formatea un número para el CSV exportado usando COMA como separador
// decimal (Excel en español/Latinoamérica lo necesita así; si se exporta
// con punto, Excel interpreta "120.50" como el número entero 12050).
// Esto solo afecta al archivo CSV: el resto de la app sigue mostrando los
// números con punto como siempre (fmtMoney, inputs, tablas, etc. no cambian).
// Si el campo termina teniendo una coma, downloadCSV lo entrecomilla
// automáticamente (ver csvEscapeField) para que Excel no lo separe en dos
// columnas.
function csvNumber(n, decimals){
  n = Number(n) || 0;
  const str = (typeof decimals === 'number') ? n.toFixed(decimals) : String(n);
  return str.replace('.', ',');
}

function downloadCSV(filename, header, rows){
  // Asegura que TODAS las filas tengan exactamente el mismo número de columnas
  // que el encabezado (ni una más ni una menos). Así ningún producto puede
  // salir "desfasado" (dato en la columna equivocada) aunque su registro venga
  // incompleto o tenga campos de más.
  const hLen = header.length;
  const csv = [header, ...rows].map(r => {
    const row = Array.isArray(r) ? r.slice(0, hLen) : [];
    while(row.length < hLen) row.push('');
    return row.map(csvEscapeField).join(',');
  }).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Exporta a Excel (.xls en formato XML 2003) con TIPOS DE COLUMNA explícitos.
// A diferencia del CSV, Excel abre este archivo sin "errores" ni apóstrofos:
// los códigos van como Texto (no se convierten a número ni se pierden) y los
// precios/stock como Número. Cada hoja: { name, header, rows, types } donde
// types es un arreglo de 'text'/'number' en el mismo orden que header.
function downloadXLS(filename, sheets){
  const escXML = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const p = [];
  p.push('<?xml version="1.0" encoding="UTF-8"?>');
  p.push('<?mso-application progid="Excel.Sheet"?>');
  p.push('<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">');
  sheets.forEach(sheet => {
    p.push(`<Worksheet ss:Name="${escXML(sheet.name)}"><Table>`);
    p.push('<Row>' + sheet.header.map(h => `<Cell><Data ss:Type="String">${escXML(h)}</Data></Cell>`).join('') + '</Row>');
    sheet.rows.forEach(row => {
      const cells = row.map((v, i) => {
        if(sheet.types[i] === 'number'){
          const n = Number(v) || 0;
          return `<Cell><Data ss:Type="Number">${n}</Data></Cell>`;
        }
        return `<Cell><Data ss:Type="String">${escXML(v)}</Data></Cell>`;
      });
      p.push('<Row>' + cells.join('') + '</Row>');
    });
    p.push('</Table></Worksheet>');
  });
  p.push('</Workbook>');
  const blob = new Blob([p.join('')], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Parsea un archivo .xls en formato XML 2003 (el mismo que genera downloadXLS)
// y devuelve un arreglo de filas, para poder importarlo en la app igual que un CSV.
function parseExcelXML(text){
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const rows = [];
  const rowEls = doc.getElementsByTagName('Row');
  for(let i = 0; i < rowEls.length; i++){
    const cells = rowEls[i].getElementsByTagName('Cell');
    const row = [];
    for(let j = 0; j < cells.length; j++){
      const dataEls = cells[j].getElementsByTagName('Data');
      row.push(dataEls.length ? (dataEls[0].textContent || '') : '');
    }
    rows.push(row);
  }
  return rows;
}

// ¿El archivo importado es un .xls de Excel (XML 2003) en vez de un CSV?
function isExcelXMLFile(file, text){
  const name = String(file && file.name || '').toLowerCase();
  if(name.endsWith('.xls')) return true;
  return String(text || '').trim().startsWith('<?xml');
}

// Exporta los productos a un archivo Excel (.xls) que abre directo sin errores
// ni apóstrofos. El CSV no podía hacerlo: Excel detecta la columna de códigos
// como número (por la mayoría de códigos numéricos) y marca como "errores" los
// alfanuméricos (los INGCO salían sin código). Con .xls cada columna declara
// su tipo (Texto para códigos, Número para precios) y Excel no infiere nada.
// La columna IMAGEN solo marca si el producto tiene foto guardada en este
// dispositivo: las fotos completas se respaldan con "Exportar backup" (JSON).
function exportProductosExcel(){
  if(db.productos.length === 0){
    toast('No hay productos para exportar', 'error');
    return;
  }
  const header = ['CODIGO','CODIGO DE BARRAS','DESCRIPCION','MARCA','CATEGORIA','PRECIO COMPRA','PRECIO MARCA','PRECIO VENTA','STOCK','STOCK MIN','CARACTERISTICAS','IMAGEN'];
  const types = ['text','text','text','text','text','number','number','number','number','number','text','text'];
  const rows = db.productos.map(p => [
    p.codigo || '', p.codigoBarras || '', p.nombre, p.marca || '', p.categoria || '',
    p.precioCompra, p.precioMarca, p.precioVenta, p.stock,
    p.stockMin,
    p.caracteristicas || '',
    getImage(p.id) ? '[foto local]' : ''
  ]);
  downloadXLS(`stockferre_productos_${todayISO().slice(0,10)}.xls`, [{ name: 'Productos', header, rows, types }]);
  toast('Productos exportados a Excel (las fotos se respaldan con "Exportar backup")', 'success');
}

// Importa un CSV de inventario (CODIGO, DESCRIPCION, ..., STOCK) para
// actualizar el stock y el código de barras de productos que YA existen.
// No crea productos nuevos (para eso está la importación de Productos, que
// sí incluye precios).
function importInventarioCSV(file){
  const reader = new FileReader();
  reader.onload = (e)=>{
    try{
      const rows = parseCSV(e.target.result);
      if(rows.length < 2){
        toast('El archivo CSV no tiene datos', 'error');
        return;
      }
      const headers = rows[0].map(normalizeHeader);
      const idx = {
        codigo: headers.indexOf('CODIGO'),
        codigoBarras: headers.findIndex(h => h.includes('BARRA') || h.includes('BARCODE')),
        stock: headers.findIndex(h => h.includes('STOCK') || h.includes('CANTIDAD'))
      };
      if(idx.codigo === -1 || idx.stock === -1){
        toast('El CSV debe tener al menos columnas CODIGO y STOCK', 'error');
        return;
      }
      let actualizados = 0, noEncontrados = 0;
      const actualizadosList = [];
      for(let i = 1; i < rows.length; i++){
        const r = rows[i];
        const codigo = String(r[idx.codigo] || '').trim();
        if(!codigo) continue;
        const p = getProductoByCodigo(codigo);
        if(!p){ noEncontrados++; continue; }
        const stockAnterior = p.stock || 0;
        const nuevoStock = parseFloat(String(r[idx.stock] ?? '').replace(',','.'));
        if(!isNaN(nuevoStock)) p.stock = nuevoStock;
        if(idx.codigoBarras > -1){
          const cb = String(r[idx.codigoBarras] || '').trim();
          if(cb) p.codigoBarras = cb;
        }
        touchProducto(p);
        markInventarioActualizado(p.id);
        logInventarioHistorial(p, p.stock - stockAnterior, 'importación CSV');
        actualizadosList.push(p);
        actualizados++;
      }
      saveDB();
      syncProductoDocs(actualizadosList, currentModo); // el stock exacto también va a la nube
      renderInventario();
      renderProductos();
      renderHistorial();
      toast(`Inventario importado: ${actualizados} actualizados${noEncontrados ? ', ' + noEncontrados + ' no encontrados' : ''}`, 'success');
    }catch(err){
      console.error(err);
      toast('No se pudo leer el archivo CSV. Verifica el formato.', 'error');
    }
  };
  reader.onerror = ()=> toast('Error al leer el archivo', 'error');
  reader.readAsText(file, 'UTF-8');
}

function exportVentasCSV(){
  if(db.ventas.length === 0){
    toast('No hay ventas para exportar', 'error');
    return;
  }
  const header = ['FECHA','CODIGO','PRODUCTO','CANTIDAD','PRECIO UNITARIO','TOTAL','METODO DE PAGO','EFECTIVO','QR','QR PERSONA'];
  const rows = db.ventas.map(v => [
    v.fecha, csvText(v.codigo), v.nombre, csvNumber(v.cantidad), csvNumber(v.precioUnitario, 2), csvNumber(v.total, 2), v.metodoPago,
    csvNumber(efectivoMontoDeVenta(v), 2), csvNumber(qrMontoDeVenta(v), 2), csvText(v.qrPersona || '')
  ]);
  downloadCSV(`stockferre_ventas_${todayISO().slice(0,10)}.csv`, header, rows);
  toast('Ventas exportadas', 'success');
}

// Importa ventas desde un CSV (por ejemplo, un backup exportado antes). Se
// agregan como nuevos registros al historial de ventas; NO vuelve a
// descontar del stock (para evitar descontarlo dos veces si esas ventas ya
// habían afectado el stock cuando se registraron originalmente).
function importVentasCSV(file){
  const reader = new FileReader();
  reader.onload = (e)=>{
    try{
      const rows = parseCSV(e.target.result);
      if(rows.length < 2){
        toast('El archivo CSV no tiene datos', 'error');
        return;
      }
      const headers = rows[0].map(normalizeHeader);
      const idx = {
        fecha: headers.indexOf('FECHA'),
        codigo: headers.indexOf('CODIGO'),
        nombre: headers.findIndex(h => h.includes('PRODUCTO') || h.includes('DESCRIPCION')),
        cantidad: headers.indexOf('CANTIDAD'),
        precioUnitario: headers.findIndex(h => h.includes('PRECIO') && h.includes('UNITARIO')),
        total: headers.indexOf('TOTAL'),
        metodoPago: headers.findIndex(h => h.includes('PAGO')),
        efectivo: headers.findIndex(h => h.includes('EFECTIVO')),
        qrMonto: headers.findIndex(h => h === 'QR'),
        qrPersona: headers.findIndex(h => h.includes('PERSONA'))
      };
      if(idx.codigo === -1 || idx.nombre === -1 || idx.total === -1){
        toast('El CSV debe tener al menos columnas CODIGO, PRODUCTO y TOTAL', 'error');
        return;
      }
      let importadas = 0;
      for(let i = 1; i < rows.length; i++){
        const r = rows[i];
        const nombre = String(r[idx.nombre] || '').trim();
        if(!nombre) continue;
        const cantidad = idx.cantidad > -1 ? (parseFloat(String(r[idx.cantidad]).replace(',','.')) || 1) : 1;
        const total = parsePrecio(r[idx.total]);
        const precioUnitario = idx.precioUnitario > -1 ? parsePrecio(r[idx.precioUnitario]) : (cantidad > 0 ? total / cantidad : 0);
        const mp = idx.metodoPago > -1 ? String(r[idx.metodoPago] || '').toLowerCase() : '';
        const metodoPago = mp.includes('mixto') ? 'mixto' : (mp.includes('qr') ? 'qr' : 'efectivo');
        let efectivoMonto = 0, qrMonto = 0;
        if(metodoPago === 'mixto'){
          efectivoMonto = idx.efectivo > -1 ? parsePrecio(r[idx.efectivo]) : 0;
          qrMonto = idx.qrMonto > -1 ? parsePrecio(r[idx.qrMonto]) : (total - efectivoMonto);
        }else if(metodoPago === 'qr'){
          qrMonto = total;
        }else{
          efectivoMonto = total;
        }
        db.ventas.push({
          id: uid('venta'),
          codigo: String(r[idx.codigo] || '').trim() || 'OTRO',
          nombre,
          cantidad,
          precioUnitario,
          total,
          metodoPago,
          qrPersona: idx.qrPersona > -1 ? String(r[idx.qrPersona] || '').trim() : '',
          efectivoMonto,
          qrMonto,
          fecha: idx.fecha > -1 ? (r[idx.fecha] || todayISO()) : todayISO()
        });
        importadas++;
      }
      db.ventas.sort((a,b)=> new Date(b.fecha) - new Date(a.fecha));
      saveDB();
      renderVentas();
      toast(`Ventas importadas: ${importadas} (no se modificó el stock)`, 'success');
    }catch(err){
      console.error(err);
      toast('No se pudo leer el archivo CSV. Verifica el formato.', 'error');
    }
  };
  reader.onerror = ()=> toast('Error al leer el archivo', 'error');
  reader.readAsText(file, 'UTF-8');
}

function exportInventarioCSV(){
  if(db.productos.length === 0){
    toast('No hay productos para exportar', 'error');
    return;
  }
  const header = ['CODIGO','DESCRIPCION','MARCA','CATEGORIA','CODIGO DE BARRAS','STOCK'];
  const rows = db.productos.map(p => [
    csvText(p.codigo), p.nombre, p.marca||'', p.categoria||'', csvText(p.codigoBarras||''), csvNumber(p.stock)
  ]);
  downloadCSV(`stockferre_inventario_${todayISO().slice(0,10)}.csv`, header, rows);
  toast('Inventario exportado', 'success');
}

/* -------------------------------------------------------------------------
   5. VISTA: PRODUCTOS (tabla, búsqueda, filtro por categoría)
   ------------------------------------------------------------------------- */

function populateCategoryFilter(){
  const sel = document.getElementById('prodFilterCategoria');
  const current = sel.value;
  const cats = getAllCategoryNames();
  sel.innerHTML = '<option value="">Todas las categorías</option>' +
    cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  if(cats.includes(current)) sel.value = current;
}

function populateCategoryDatalist(){
  const dl = document.getElementById('categoriasList');
  dl.innerHTML = getAllCategoryNames().map(c => `<option value="${escapeHtml(c)}">`).join('');
}

function getAllCategoryNames(){
  const set = new Set(db.categorias.map(c => c.trim()).filter(Boolean));
  db.productos.forEach(p => { if(p.categoria) set.add(p.categoria.trim()); });
  return Array.from(set).sort((a,b)=> a.localeCompare(b, 'es'));
}

function renderProductos(){
  resetImgLazy();
  populateCategoryFilter();
  populateCategoryDatalist();

  const search = normalize(document.getElementById('prodSearch').value);
  const catFilter = document.getElementById('prodFilterCategoria').value;

  let list = db.productos.slice();
  if(catFilter){
    list = list.filter(p => normalize(p.categoria) === normalize(catFilter));
  }
  if(search){
    list = list.filter(p =>
      normalize(p.nombre).includes(search) ||
      normalize(p.codigo).includes(search) ||
      normalize(p.marca).includes(search)
    );
  }
  list.sort((a,b)=> a.nombre.localeCompare(b.nombre, 'es'));

  const tbody = document.querySelector('#productsTable tbody');
  if(list.length === 0){
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${currentRole === 'guest' ? 11 : 12}">No hay productos que coincidan.</td></tr>`;
  }else{
    tbody.innerHTML = list.map((p, idx) => {
      const bajo = (p.stockMin || 0) > 0 && p.stock <= p.stockMin;
      const img = getImage(p.id);
      const countImg = getImageCount(p.id);
      const thumb = img
        ? (idx < IMG_LAZY_FIRST
            ? `<img src="${img}" class="prod-thumb" alt="" data-img-product="${p.id}" decoding="async">`
            : `<div class="prod-thumb-lazy" data-lazy-img="${p.id}"><div class="prod-thumb prod-thumb-empty">🖼️</div></div>`)
        : `<div class="prod-thumb prod-thumb-empty">🖼️</div>`;
      return `
      <tr data-product-id="${p.id}">
        <td class="prod-img-cell">
          <div class="prod-img-wrap">
            ${thumb}
            ${countImg > 1 ? `<span class="prod-img-count" data-img-product="${p.id}">${countImg}</span>` : ''}
            ${currentRole === 'guest' ? '' : `<button class="btn btn-sm btn-secondary prod-img-btn" data-img-product="${p.id}">Añadir foto</button>`}
          </div>
        </td>
        <td><strong>${escapeHtml(p.codigo)}</strong></td>
        <td>${escapeHtml(p.codigoBarras || '-')}</td>
        <td>${escapeHtml(p.nombre)}</td>
        <td>${escapeHtml(p.marca || '-')}</td>
        <td>${p.categoria ? `<span class="badge badge-muted">${escapeHtml(p.categoria)}</span>` : '-'}</td>
        <td class="price-guest-hide">${fmtMoney(p.precioCompra)}</td>
        <td class="price-guest-hide">${fmtMoney(p.precioMarca)}</td>
        <td>${fmtMoney(p.precioVenta)}</td>
        <td>${p.stock}${bajo ? ' <span class="badge badge-danger-soft">Bajo</span>' : ''}</td>
        <td>${p.stockMin || 0}</td>
        ${currentRole === 'guest' ? '' : `
        <td>
          <button class="btn-icon" title="Editar" data-edit-product="${p.id}">✏️</button>
          <button class="btn-icon" title="Eliminar" data-delete-product="${p.id}">🗑️</button>
        </td>`}
      </tr>`;
    }).join('');
    armImgLazyLoader(tbody);
  }

  updateSidebarProductCount();
}

function updateSidebarProductCount(){
  const el = document.getElementById('sidebarProductCount');
  if(el) el.textContent = `${db.productos.length} producto${db.productos.length === 1 ? '' : 's'}`;
}

/* -------------------------------------------------------------------------
   6. VISTA: CATEGORÍAS (botones para filtrar)
   ------------------------------------------------------------------------- */

function renderCategorias(){
  const grid = document.getElementById('categoriesGrid');
  const cats = getAllCategoryNames();

  if(cats.length === 0){
    grid.innerHTML = `<p class="hint">Aún no hay categorías. Agrega una arriba o crea productos con categoría.</p>`;
    return;
  }

  grid.innerHTML = cats.map(c => {
    const count = db.productos.filter(p => normalize(p.categoria) === normalize(c)).length;
    return `
      <button class="stat-card" style="text-align:left; cursor:pointer; border:none;" data-filter-category="${escapeHtml(c)}">
        <div class="stat-label">${escapeHtml(c)}</div>
        <div class="stat-value">${count}</div>
      </button>`;
  }).join('');

  grid.querySelectorAll('[data-filter-category]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      const cat = btn.dataset.filterCategory;
      showView('productos');
      document.getElementById('prodFilterCategoria').value = cat;
      renderProductos();
    });
  });
}

/* -------------------------------------------------------------------------
   7. MODAL DE PRODUCTO
   ------------------------------------------------------------------------- */

function openProductModal(producto, prefillCodigo){
  const form = document.getElementById('formProducto');
  form.reset();
  populateCategoryDatalist();

  if(producto){
    document.getElementById('modalProductoTitle').textContent = 'Editar producto';
    document.getElementById('pId').value = producto.id;
    document.getElementById('pCodigo').value = producto.codigo;
    document.getElementById('pCodigoBarras').value = producto.codigoBarras || '';
    document.getElementById('pNombre').value = producto.nombre;
    document.getElementById('pMarca').value = producto.marca || '';
    document.getElementById('pCategoria').value = producto.categoria || '';
    document.getElementById('pPrecioCompra').value = producto.precioCompra || '';
    document.getElementById('pPrecioMarca').value = producto.precioMarca || '';
    document.getElementById('pPrecioVenta').value = producto.precioVenta || '';
  }else{
    document.getElementById('modalProductoTitle').textContent = 'Nuevo producto';
    document.getElementById('pId').value = '';
    if(prefillCodigo) document.getElementById('pCodigo').value = prefillCodigo;
  }
  openModal('modalProducto');
}

function handleProductSubmit(e){
  e.preventDefault();
  const data = {
    id: document.getElementById('pId').value || null,
    codigo: document.getElementById('pCodigo').value,
    codigoBarras: document.getElementById('pCodigoBarras').value,
    nombre: document.getElementById('pNombre').value,
    marca: document.getElementById('pMarca').value,
    categoria: document.getElementById('pCategoria').value,
    precioCompra: document.getElementById('pPrecioCompra').value,
    precioMarca: document.getElementById('pPrecioMarca').value,
    precioVenta: document.getElementById('pPrecioVenta').value
  };
  if(!data.codigo.trim() || !data.nombre.trim()){
    toast('Código y descripción son obligatorios', 'error');
    return;
  }
  // Evitar duplicar código en otro producto distinto
  const dup = getProductoByCodigo(data.codigo);
  if(dup && dup.id !== data.id){
    toast('Ya existe otro producto con ese código', 'error');
    return;
  }
  const saved = saveProducto(data);
  closeAllModals();
  renderProductos();
  renderCategorias();
  toast('Producto guardado', 'success');
  // Si venimos del escáner, refresca el resultado mostrado
  if(saved) renderScanResult(saved.codigo);
}

/* -------------------------------------------------------------------------
   7b. IMAGEN DEL PRODUCTO (local, no Firebase)
   ------------------------------------------------------------------------- */
let imgTargetId = null;
let imgTargetIndex = 0; // foto actualmente visible en el carrusel del modal
let detTargetId = null; // id del producto abierto en la ventana de características

// Muestra la ventana con las características del producto. Los campos que se
// ven aquí coinciden con las columnas del CSV exportar/importar.
function openProductDetails(productId){
  const p = getProductoById(productId);
  if(!p) return;
  detTargetId = productId;
  // Todas las fotos del producto, deslizables.
  const detImgs = getImages(p.id);
  const detImg = document.getElementById('detImg');
  // Si la página en caché es vieja, detImg es un <img>: se muestra la primera foto.
  if(detImg.tagName !== 'DIV'){
    if(detImgs.length){
      detImg.src = detImgs[0];
      detImg.style.display = 'block';
    }else{
      detImg.removeAttribute('src');
      detImg.style.display = 'none';
    }
  }else if(detImgs.length){
    detImg.innerHTML = detImgs.map((src, i)=>`<img src="${src}" alt="Foto ${i+1}" decoding="async">`).join('');
    detImg.style.display = 'flex';
  }else{
    detImg.innerHTML = '';
    detImg.style.display = 'none';
  }
  updateDetImgCounter();
  document.getElementById('detCodigo').textContent = p.codigo || '-';
  document.getElementById('detBarras').textContent = p.codigoBarras || '-';
  document.getElementById('detNombre').textContent = p.nombre || '-';
  document.getElementById('detMarca').textContent = p.marca || '-';
  document.getElementById('detCategoria').textContent = p.categoria || '-';
  document.getElementById('detPCompra').textContent = fmtMoney(p.precioCompra);
  document.getElementById('detPMarca').textContent = fmtMoney(p.precioMarca);
  document.getElementById('detPVenta').textContent = fmtMoney(p.precioVenta);
  document.getElementById('detStock').textContent = p.stock;
  document.getElementById('detStockMin').textContent = p.stockMin || 0;
  document.getElementById('detCaracteristicas').value = p.caracteristicas || '';
  // Los invitados no tienen acceso a Ingresos, así que se les oculta el botón.
  const detVerIngresos = document.getElementById('btnDetVerIngresos');
  if(detVerIngresos) detVerIngresos.style.display = currentRole === 'guest' ? 'none' : '';
  openModal('modalProductoDetalle');
}

// Muestra "2 / 3" debajo de las fotos del modal de detalles al deslizar.
function updateDetImgCounter(){
  const carousel = document.getElementById('detImg');
  const counter = document.getElementById('detImgCounter');
  if(!counter || !carousel || carousel.tagName !== 'DIV') return;
  const imgs = carousel.querySelectorAll('img');
  if(imgs.length < 2){ counter.textContent = ''; return; }
  const center = carousel.scrollLeft + carousel.clientWidth / 2;
  let active = 0;
  imgs.forEach((img, i)=>{
    const c = img.offsetLeft + img.offsetWidth / 2;
    if(Math.abs(c - center) < Math.abs(imgs[active].offsetLeft + imgs[active].offsetWidth / 2 - center)) active = i;
  });
  counter.textContent = (active + 1) + ' / ' + imgs.length;
}

// Guarda las características escritas en el recuadro blanco de la ventana del producto.
function saveDetCaracteristicas(){
  const p = getProductoById(detTargetId);
  if(!p){ toast('No se pudo guardar', 'error'); return; }
  p.caracteristicas = document.getElementById('detCaracteristicas').value;
  touchProducto(p);
  saveDB();
  syncProductoDoc(p); // mantiene el documento del producto en la nube al día
  renderProductos();
  toast('Características guardadas', 'success');
}

function openImageModal(productId){
  const p = getProductoById(productId);
  if(!p) return;
  imgTargetId = productId;
  imgTargetIndex = 0;
  document.getElementById('imgProductName').textContent = p.nombre;
  document.getElementById('imgProductCode').textContent = p.codigo + (p.codigoBarras ? ' · ' + p.codigoBarras : '');
  renderImgCarousel();
  document.getElementById('imgUrlInput').value = '';
  document.getElementById('imgUrlStatus').style.display = 'none';
  document.getElementById('btnImgLoadUrl').disabled = false;
  openModal('modalImagen');
}

// Dibuja todas las fotos del producto en el carrusel (se desliza al arrastrar).
function renderImgCarousel(){
  const imgs = getImages(imgTargetId);
  const carousel = document.getElementById('imgPreview');
  const wrap = document.getElementById('imgPreviewWrap');
  const info = document.getElementById('imgPreviewInfo');
  const removeBtn = document.getElementById('btnImgRemove');
  if(!carousel) return;
  // Si la página en caché es vieja, imgPreview es un <img> y no un carrusel:
  // se usa el modo simple (una sola foto a la vez).
  if(carousel.tagName !== 'DIV'){
    if(imgs.length){
      carousel.src = imgs[0];
      carousel.style.display = 'block';
      if(removeBtn) removeBtn.style.display = '';
    }else{
      carousel.removeAttribute('src');
      carousel.style.display = 'none';
      if(removeBtn) removeBtn.style.display = 'none';
    }
    if(wrap) wrap.style.display = imgs.length ? 'block' : 'none';
    if(info) info.style.display = 'none';
    return;
  }
  if(imgs.length === 0){
    carousel.innerHTML = '';
    if(wrap) wrap.style.display = 'none';
    if(info) info.style.display = 'none';
    if(removeBtn) removeBtn.style.display = 'none';
    return;
  }
  carousel.innerHTML = imgs.map((src, i)=>`<img src="${src}" alt="Foto ${i+1}" data-index="${i}" decoding="async">`).join('');
  if(wrap) wrap.style.display = 'block';
  if(info) info.style.display = 'flex';
  if(removeBtn) removeBtn.style.display = '';
  carousel.scrollLeft = 0;
  updateImgIndicator();
}

// Actualiza el contador, los puntos y las flechas según la foto visible.
function updateImgIndicator(){
  const carousel = document.getElementById('imgPreview');
  if(!carousel || carousel.tagName !== 'DIV') return;
  // querySelectorAll devuelve un NodeList (sin .map): se convierte a arreglo.
  const imgs = Array.from(carousel.querySelectorAll('img'));
  const total = imgs.length;
  if(!total) return;
  // La foto activa es la que está más cerca del centro del carrusel.
  const center = carousel.scrollLeft + carousel.clientWidth / 2;
  let active = 0;
  imgs.forEach((img, i)=>{
    const c = img.offsetLeft + img.offsetWidth / 2;
    if(Math.abs(c - center) < Math.abs(imgs[active].offsetLeft + imgs[active].offsetWidth / 2 - center)) active = i;
  });
  imgTargetIndex = active;
  const counter = document.getElementById('imgPreviewCounter');
  if(counter) counter.textContent = (active + 1) + ' / ' + total;
  const dots = document.getElementById('imgPreviewDots');
  if(dots) dots.innerHTML = imgs.map((_, i)=>
    `<span class="carousel-dot${i === active ? ' active' : ''}" data-index="${i}"></span>`
  ).join('');
  const prev = document.getElementById('btnImgPrev');
  const next = document.getElementById('btnImgNext');
  if(prev) prev.style.visibility = total > 1 ? 'visible' : 'hidden';
  if(next) next.style.visibility = total > 1 ? 'visible' : 'hidden';
  const removeBtn = document.getElementById('btnImgRemove');
  if(removeBtn) removeBtn.textContent = total > 1 ? `🗑️ Quitar foto ${active + 1}/${total}` : '🗑️ Quitar imagen';
}

// Mueve el carrusel hacia el lado indicado (1 = siguiente, -1 = anterior).
function slideImgCarousel(dir){
  const carousel = document.getElementById('imgPreview');
  if(!carousel || carousel.tagName !== 'DIV') return;
  const imgs = carousel.querySelectorAll('img');
  if(imgs.length < 2) return;
  const next = Math.min(Math.max(imgTargetIndex + dir, 0), imgs.length - 1);
  const targetLeft = imgs[next].getBoundingClientRect().left - carousel.getBoundingClientRect().left + carousel.scrollLeft;
  carousel.scrollTo({ left: targetLeft, behavior: 'smooth' });
  imgTargetIndex = next;
  updateImgIndicator();
}

function handleImgFile(file){
  if(!file || !imgTargetId) return;
  if(getImages(imgTargetId).length >= MAX_IMGS){ toast('Máximo 3 fotos por producto', 'error'); return; }
  compressImage(file).then(data=>{
    return saveImageLocal(imgTargetId, data);
  }).then(ok=>{
    if(ok){
      renderImgCarousel();
      renderProductos();
      toast('Foto añadida en este dispositivo', 'success');
    }else{
      toast('No se pudo guardar la imagen', 'error');
    }
  }).catch(err=>{
    console.error(err);
    toast('No se pudo leer la imagen', 'error');
  });
}

function handleImgUrl(){
  const url = document.getElementById('imgUrlInput').value.trim();
  if(!url || !imgTargetId){ toast('Escribe una URL válida', 'error'); return; }
  if(getImages(imgTargetId).length >= MAX_IMGS){ toast('Máximo 3 fotos por producto', 'error'); return; }
  const btn = document.getElementById('btnImgLoadUrl');
  const status = document.getElementById('imgUrlStatus');
  btn.disabled = true;
  if(status){ status.style.display = 'block'; status.textContent = '⏳ Cargando imagen... (si tarda, se intenta con un proxy)'; }
  fetchImageAsDataURL(url).then(data=>{
    status.textContent = '⏳ Comprimiendo imagen...';
    return compressDataURL(data);
  }).then(compressed=>{
    // Se guarda también el link original: así el export puede mostrar la URL
    // de la foto en la columna IMAGEN (respaldo del origen de cada imagen).
    return saveImageLocal(imgTargetId, compressed, url);
  }).then(ok=>{
    btn.disabled = false;
    if(status) status.style.display = 'none';
    if(ok){
      renderImgCarousel();
      renderProductos();
      document.getElementById('imgUrlInput').value = '';
      toast('Foto añadida (con su link) en este dispositivo', 'success');
    }else{
      toast('No se pudo guardar la imagen', 'error');
    }
  }).catch(err=>{
    btn.disabled = false;
    const msg = (err && err.message) ? err.message : 'No se pudo cargar la imagen desde esa URL.';
    if(status){ status.style.display = 'block'; status.textContent = '⚠️ ' + msg; }
    console.error(err);
    toast('No se pudo cargar la imagen desde esa URL', 'error');
  });
}

function removeCurrentImage(){
  if(!imgTargetId) return;
  const imgs = getImages(imgTargetId);
  if(imgs.length === 0) return;
  const idx = Math.min(Math.max(imgTargetIndex, 0), imgs.length - 1);
  const nombre = document.getElementById('imgProductName').textContent;
  const texto = imgs.length > 1
    ? `¿Quitar la foto ${idx + 1} de ${imgs.length} de "${nombre}"?`
    : `¿Quitar la imagen de "${nombre}"?`;
  confirmDialog('Quitar foto', texto, ()=>{
    removeImageAtLocal(imgTargetId, idx).then(ok=>{
      if(ok){
        imgTargetIndex = Math.max(0, idx - 1);
        renderImgCarousel();
        renderProductos();
        toast('Foto quitada', 'success');
      }else{
        toast('No se pudo quitar la foto', 'error');
      }
    });
  });
}

/* -------------------------------------------------------------------------
   8. IMPORTAR CSV DE PRODUCTOS
   ------------------------------------------------------------------------- */

// Excel en español guarda "CSV separado por comas" usando en realidad punto y
// coma (porque usa la coma como separador decimal de los precios). Detectamos
// el delimitador real mirando la primera línea del archivo.
function detectDelimiter(text){
  const firstLine = text.split(/\r\n|\r|\n/, 1)[0] || '';
  const candidates = [',', ';', '\t'];
  let best = ',', bestCount = 0;
  candidates.forEach(d=>{
    const count = firstLine.split(d).length - 1;
    if(count > bestCount){ bestCount = count; best = d; }
  });
  return best;
}

// Parser CSV: soporta coma, punto y coma o tabulador como delimitador,
// y campos entre comillas.
function parseCSV(text, delimiter){
  // Quita el BOM (marca de orden de bytes) que Excel agrega al guardar "CSV UTF-8"
  text = text.replace(/^\uFEFF/, '');
  text = text.replace(/\r\n/g,'\n').replace(/\r/g,'\n');
  delimiter = delimiter || detectDelimiter(text);

  // Quita el apóstrofo con que se exportan los códigos para que Excel los lea
  // como texto (ver csvText). Así, al re-importar, '12399 vuelve a ser 12399.
  const clean = f => (f.length && f[0] === "'") ? f.slice(1) : f;

  const rows = [];
  let row = [], field = '', inQuotes = false;

  for(let i = 0; i < text.length; i++){
    const ch = text[i];
    if(inQuotes){
      if(ch === '"'){
        if(text[i+1] === '"'){ field += '"'; i++; }
        else{ inQuotes = false; }
      }else{
        field += ch;
      }
    }else{
      if(ch === '"'){ inQuotes = true; }
      else if(ch === delimiter){ row.push(clean(field)); field = ''; }
      else if(ch === '\n'){ row.push(clean(field)); rows.push(row); row = []; field = ''; }
      else{ field += ch; }
    }
  }
  if(field.length || row.length){ row.push(clean(field)); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim() !== ''));
}

function normalizeHeader(h){
  return String(h||'')
    .trim().toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'') // quita acentos
    .replace(/\s+/g,' ');
}

function parsePrecio(raw){
  if(raw === undefined || raw === null) return 0;
  const cleaned = String(raw).trim().replace(/[^\d.,-]/g,'');
  if(!cleaned) return 0;
  // Si usa coma como decimal y no hay punto, conviértela
  const normalized = (cleaned.includes(',') && !cleaned.includes('.'))
    ? cleaned.replace(',', '.')
    : cleaned.replace(/,/g,'');
  const n = parseFloat(normalized);
  return isNaN(n) ? 0 : n;
}

function importProductsCSV(file){
  const reader = new FileReader();
  reader.onload = (e)=>{
    try{
      // Acepta CSV (coma, punto y coma o tabulador) o .xls exportado por la app
      // (Excel XML 2003) para que lo que se exporta también se pueda importar.
      const text = e.target.result;
      const rows = isExcelXMLFile(file, text) ? parseExcelXML(text) : parseCSV(text);
      if(rows.length < 2){
        toast('El archivo CSV no tiene datos', 'error');
        return;
      }
      const headers = rows[0].map(normalizeHeader);
      const idx = {
        codigo: headers.indexOf('CODIGO'),
        codigoBarras: headers.findIndex(h => h.includes('BARRA') || h.includes('BARCODE')),
        nombre: headers.findIndex(h => h.includes('DESCRIPCION') || h === 'NOMBRE'),
        marca: headers.indexOf('MARCA'),
        categoria: headers.indexOf('CATEGORIA'),
        // Acepta "PRECIO COMPRA", "PRECIO DE COMPRA", "PRECIO_COMPRA", etc.
        precioCompra: headers.findIndex(h => h.includes('PRECIO') && h.includes('COMPRA')),
        precioMarca: headers.findIndex(h => h.includes('PRECIO') && h.includes('MARCA') && !h.includes('BARRA')),
        precioVenta: headers.findIndex(h => h.includes('PRECIO') && h.includes('VENTA')),
        stock: headers.findIndex(h => h.includes('STOCK') && !h.includes('MIN')),
        stockMin: headers.findIndex(h => h.includes('STOCK') && h.includes('MIN')),
        caracteristicas: headers.findIndex(h => h.includes('CARACTERISTICA') || h.includes('OBSERVACION') || h.includes('NOTA')),
        imagen: headers.findIndex(h => h.includes('IMAGEN') || h.includes('FOTO'))
      };
      if(idx.codigo === -1 || idx.nombre === -1){
        toast('El CSV debe tener al menos columnas CODIGO y DESCRIPCION', 'error');
        return;
      }
      if(idx.precioCompra === -1 || idx.precioVenta === -1){
        toast('No se encontraron las columnas de precio (se importarán los productos, pero revisa los precios manualmente)', 'warning');
      }

      let creados = 0, actualizados = 0;
      const importadosList = [];
      for(let i = 1; i < rows.length; i++){
        const r = rows[i];
        const codigo = String(r[idx.codigo] || '').trim();
        if(!codigo) continue;
        const codigoBarras = idx.codigoBarras > -1 ? String(r[idx.codigoBarras] || '').trim() : '';
        const nombre = String(r[idx.nombre] || '').trim();
        const marca = idx.marca > -1 ? String(r[idx.marca] || '').trim() : '';
        const categoria = idx.categoria > -1 ? String(r[idx.categoria] || '').trim() : '';
        const precioCompra = idx.precioCompra > -1 ? parsePrecio(r[idx.precioCompra]) : 0;
        const precioMarca = idx.precioMarca > -1 ? parsePrecio(r[idx.precioMarca]) : 0;
        const precioVenta = idx.precioVenta > -1 ? parsePrecio(r[idx.precioVenta]) : 0;
        const stockVal = idx.stock > -1 ? parsePrecio(r[idx.stock]) : null;
        const stockMinVal = idx.stockMin > -1 ? parsePrecio(r[idx.stockMin]) : null;
        const caracteristicas = idx.caracteristicas > -1 ? String(r[idx.caracteristicas] || '').trim() : '';

        if(categoria) upsertCategoria(categoria);

        let productoId = null;
        const existing = getProductoByCodigo(codigo);
        if(existing){
          existing.nombre = nombre || existing.nombre;
          existing.marca = marca || existing.marca;
          existing.categoria = categoria || existing.categoria;
          existing.codigoBarras = codigoBarras || existing.codigoBarras;
          existing.precioCompra = precioCompra || existing.precioCompra;
          existing.precioMarca = precioMarca || existing.precioMarca;
          existing.precioVenta = precioVenta || existing.precioVenta;
          if(stockMinVal !== null) existing.stockMin = stockMinVal;
          if(caracteristicas) existing.caracteristicas = caracteristicas;
          touchProducto(existing);
          productoId = existing.id;
          importadosList.push(existing);
          actualizados++;
        }else{
          const p = {
            id: uid(),
            codigo, codigoBarras, nombre, marca, categoria,
            precioCompra, precioMarca, precioVenta,
            caracteristicas,
            stock: 0,
            stockMin: stockMinVal !== null ? stockMinVal : 0,
            fechaCreacion: todayISO(),
            _updatedAt: Date.now()
          };
          db.productos.push(p);
          productoId = p.id;
          importadosList.push(p);
          creados++;
        }
        // Si el CSV trae una columna IMAGEN, se guarda la foto en este
        // dispositivo (local, no Firebase). Si el valor es un link (https),
        // se guarda también como el link original de la foto para poder
        // re-exportarlo después (columna IMAGEN con la URL de respaldo).
        if(idx.imagen > -1 && productoId){
          const imgVal = String(r[idx.imagen] || '').trim();
          if(imgVal && (imgVal.startsWith('data:') || /^https?:\/\//i.test(imgVal))){
            // Reemplaza las fotos del producto con la del CSV (una sola foto).
            saveImagesLocal(productoId, [imgVal], /^https?:\/\//i.test(imgVal) ? [imgVal] : ['']);
          }
        }
      }
      saveDB();
      syncProductoDocs(importadosList, currentModo); // los productos importados también van a la nube
      renderProductos();
      renderCategorias();
      toast(`Importación completa: ${creados} nuevos, ${actualizados} actualizados`, 'success');
    }catch(err){
      console.error(err);
      toast('No se pudo leer el archivo CSV. Verifica el formato.', 'error');
    }
  };
  reader.onerror = ()=> toast('Error al leer el archivo', 'error');
  reader.readAsText(file, 'UTF-8');
}

/* -------------------------------------------------------------------------
   9. BACKUP / RESTAURAR (JSON)
   ------------------------------------------------------------------------- */

function exportBackup(){
  const data = Object.assign({}, db, { imagenes: imgCache, imgUrl: imgUrlCache });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `stockferre_backup_${todayISO().slice(0,10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('Backup exportado', 'success');
}

function importBackup(file){
  const reader = new FileReader();
  reader.onload = (e)=>{
    try{
      const parsed = JSON.parse(e.target.result);
      if(!parsed || !Array.isArray(parsed.productos)){
        toast('El archivo no tiene un formato de backup válido', 'error');
        return;
      }
      confirmDialog('Restaurar backup', 'Esto reemplazará todos los productos y categorías actuales. ¿Continuar?', ()=>{
        db = normalizeDB({
          productos: parsed.productos || [],
          categorias: parsed.categorias || [],
          contador: parsed.contador || { producto: (parsed.productos.length || 0) + 1, venta: 1 },
          ventas: parsed.ventas || []
        });
        saveDB();
        syncProductoDocs(db.productos, currentModo); // los productos restaurados también van a la nube
        // Restaura las imágenes locales (solo de este dispositivo), incluyendo
        // el link original de cada foto cuando lo tenía. Soporta tanto el
        // formato viejo (1 sola foto) como el nuevo (varias fotos por producto).
        const urlsMap = (parsed.imgUrl && typeof parsed.imgUrl === 'object') ? parsed.imgUrl : {};
        if(parsed.imagenes && typeof parsed.imagenes === 'object'){
          Promise.all(
            Object.keys(parsed.imagenes).map(id => saveImagesLocal(id, parsed.imagenes[id], urlsMap[id] || ''))
          ).then(()=> loadImagesForModo(currentModo));
        }
        renderProductos();
        renderCategorias();
        toast('Backup restaurado correctamente', 'success');
      });
    }catch(err){
      console.error(err);
      toast('No se pudo leer el archivo de backup', 'error');
    }
  };
  reader.readAsText(file, 'UTF-8');
}

function factoryReset(){
  confirmDialog('Borrar todos los datos', 'Esto eliminará permanentemente todos los productos y categorías guardados en este dispositivo. ¿Estás seguro?', ()=>{
    db = defaultDB();
    invUpdates = {};
    saveInvUpdates();
    saveDB();
    clearAllImages(); // borra también las imágenes locales de ambos modos
    renderProductos();
    renderCategorias();
    renderInventario();
    document.getElementById('scanResult').innerHTML = '';
    toast('Datos borrados', 'success');
  });
}

/* -------------------------------------------------------------------------
   10. NAVEGACIÓN / VISTAS
   ------------------------------------------------------------------------- */

const VIEW_TITLES = {
  inicio: 'Inicio',
  escaner: 'Escanear',
  productos: 'Productos',
  categorias: 'Categorías',
  ventas: 'Ventas',
  topventas: 'Productos más vendidos',
  pedidos: 'Pedidos',
  compras: 'Ingresos',
  finanzas: 'Estado Financiero',
  retiros: 'Pagos',
  deudas: 'Deudas',
  gastos: 'Gastos del día',
  codigobarras: 'Añadir código de barras',
  inventario: 'Inventario',
  historial: 'Historial',
  config: 'Configuración'
};

function updateInicioClock(){
  const timeEl = document.getElementById('inicioTime');
  const dateEl = document.getElementById('inicioDate');
  if(!timeEl || !dateEl) return;
  const now = new Date();
  timeEl.textContent = now.toLocaleTimeString('es-BO', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  dateEl.textContent = now.toLocaleDateString('es-BO', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
}

function showView(name){
  if(welcomeTimer){ clearTimeout(welcomeTimer); welcomeTimer = null; }
  currentView = name;
  if(currentRole === 'guest' && (name === 'inventario' || name === 'config' || name === 'compras' || name === 'finanzas' || name === 'retiros' || name === 'deudas' || name === 'gastos' || name === 'codigobarras' || name === 'topventas' || name === 'pedidos')){
    toast('Los invitados no tienen acceso a esa sección', 'error');
    name = 'productos';
  }
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.querySelectorAll('.nav-item[data-view]').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.view === name);
  });
  document.getElementById('viewTitle').textContent = VIEW_TITLES[name] || '';
  document.body.classList.toggle('inicio-theme', name === 'inicio');
  document.body.classList.remove('welcome-view');
  closeSidebarMobile();
  closeAllModals(); // por si venías con el escáner de inventario u otro modal abierto
  restoreScannerBlockHome();
  scanContext = 'lookup';
  // Fuera de "Añadir código de barras" el modo de escáner de código de barras
  // vuelve a estar disponible en la pestaña Escanear.
  const cbTab = document.querySelector('[data-scan-code-mode="codigobarras"]');
  if(cbTab) cbTab.style.display = '';

  if(name === 'inicio') updateInicioClock();
  if(name === 'productos') renderProductos();
  if(name === 'categorias') renderCategorias();
  if(name === 'ventas') renderVentas();
  if(name === 'topventas') renderTopVentas();
  if(name === 'pedidos') renderPedidos();
  if(name === 'compras') renderCompras();
  if(name === 'finanzas') renderFinanzas();
  if(name === 'retiros') renderRetiros();
  if(name === 'deudas') renderDeudas();
  if(name === 'gastos') renderGastos();
  if(name === 'inventario') renderInventario();
  if(name === 'historial') renderHistorial();
  if(name === 'escaner'){
    document.getElementById('scanResult').innerHTML = '';
    if(!ocrActive && !zxingLiveActive) startActiveScanner();
  }else if(name === 'codigobarras'){
    openCodigoBarrasView();
  }else{
    stopActiveScanner();
  }
}

function closeSidebarMobile(){
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('open');
}

/* -------------------------------------------------------------------------
   10b. MODO: HERRAMIENTAS MANUALES / HERRAMIENTAS ELÉCTRICAS / INVITADO
   Manuales y Eléctricas son como "dos apps iguales" con bases de datos
   separadas (LocalStorage y Firebase independientes — ver
   storageKey()/invUpdatesKey()/firebaseDocId()). Cada modo puede tener su
   propia contraseña (guardada solo en este dispositivo), configurable desde
   la barra lateral de cada uno.

   El INVITADO no aparece en la pantalla principal: entra desde la puerta de
   contraseña ("Entrar como invitado") y va directo a su menú (barra lateral
   naranja), que combina los productos de Manuales y Eléctricas. El invitado
   no ve precio de compra ni de marca, no puede editar productos, y no tiene
   acceso a Inventario ni Configuración. Las ventas que registra se guardan
   en la base del modo al que pertenece el producto (ver guestCommitVenta).
   ------------------------------------------------------------------------- */
const MODO_KEY = 'stockferre_modo_v1';
const ROLE_KEY = 'stockferre_role_v1';
const REMEMBER_KEY = 'stockferre_remember_v1';
const NOTIF_KEY = 'stockferre_notif_v1';
const MODO_LABELS = { manual: 'Herramientas Manuales', electrico: 'Herramientas Eléctricas', invitado: 'Modo Invitado' };

let pendingGateModo = null;

// "Mantener sesión abierta": guarda qué modos no deben pedir contraseña en
// ESTE dispositivo (localStorage). No afecta a otros celulares ni PCs.
function getRememberedModes(){
  try{ return JSON.parse(localStorage.getItem(REMEMBER_KEY)) || {}; }catch(e){ return {}; }
}
function isRemembered(modo){ return !!getRememberedModes()[modo]; }
function setRememberedMode(modo, on){
  const obj = getRememberedModes();
  obj[modo] = !!on;
  try{ localStorage.setItem(REMEMBER_KEY, JSON.stringify(obj)); }catch(e){}
}
function syncRememberSwitchUI(){
  const sw = document.getElementById('rememberSwitch');
  if(!sw) return;
  sw.checked = currentModo === 'invitado' ? false : isRemembered(currentModo);
}

// "Activar notificaciones": avisa (con una notificación del navegador) cuando
// se registra una venta, tanto aquí como la que llega sincronizada por
// Firebase desde otro dispositivo. El permiso se pide al activar el suich y
// solo se guarda en este dispositivo.
function getNotifEnabled(){
  try{ return JSON.parse(localStorage.getItem(NOTIF_KEY)) || {}; }catch(e){ return {}; }
}
// De FÁBRICA está activado: si nunca se tocó el suich en este dispositivo, la
// opción viene en ON (el permiso del navegador se pide con el primer gesto).
function notifEnabled(modo){
  const obj = getNotifEnabled();
  if(obj[modo] === undefined) return true;
  return !!obj[modo];
}
function setNotifEnabled(modo, on){
  const obj = getNotifEnabled();
  obj[modo] = !!on;
  try{ localStorage.setItem(NOTIF_KEY, JSON.stringify(obj)); }catch(e){}
}
function syncNotifSwitchUI(){
  const sw = document.getElementById('notifySwitch');
  if(!sw) return;
  sw.checked = currentModo === 'invitado' ? false : notifEnabled(currentModo);
}

// Modo pro: recuerda en este dispositivo si el usuario lo dejó abierto (el
// submenú con Estado Financiero / Pagos / Deudas). El tema de colores es
// independiente: solo cambia los colores.
function syncProModeUI(){
  let pro = false;
  try{ pro = localStorage.getItem('stockferre_proMode') === '1'; }catch(e){}
  const group = document.getElementById('proGroup');
  const sub = document.getElementById('proSub');
  if(pro){
    if(group) group.classList.add('open');
    if(sub) sub.classList.add('open');
  }
  applyTheme(readSavedTheme(), false);
}

// Pestaña "👑 Modo Pro": al presionarla abre/cierra el submenú que se desliza
// hacia abajo con las pestañas exclusivas (Estado Financiero, Pagos, Deudas,
// Gastos del día).
function toggleProMode(){
  const group = document.getElementById('proGroup');
  const sub = document.getElementById('proSub');
  if(!group || !sub) return;
  const on = !group.classList.contains('open');
  group.classList.toggle('open', on);
  sub.classList.toggle('open', on);
  try{ localStorage.setItem('stockferre_proMode', on ? '1' : '0'); }catch(err){}
}

// Paleta de temas: blanco, negro, naranjado o amarillo.
function readSavedTheme(){
  try{
    let t = localStorage.getItem('stockferre_theme');
    if(t === 'dorado') return 'negro';
    if(t) return t;
  }catch(e){}
  return 'negro';
}

// Aplica el tema elegido en la paleta. Si showToast es true avisa con un
// mensaje (al abrir la app se aplica en silencio).
function applyTheme(color, showToast){
  if(!color || color === 'dorado') color = 'negro';
  document.body.classList.remove('theme-blanco', 'theme-negro', 'theme-naranja', 'theme-amarillo');
  document.body.classList.add('theme-' + color);
  try{ localStorage.setItem('stockferre_theme', color); }catch(err){}
  document.querySelectorAll('.palette-swatch').forEach(sw=>{
    sw.classList.toggle('active', sw.dataset.theme === color);
  });
  if(showToast){
    const NOMBRES = { blanco:'blanco', negro:'negro', naranja:'naranjado', amarillo:'amarillo' };
    toast('🎨 Tema ' + (NOMBRES[color] || color) + ' activado', 'success');
  }
}
function notificationsSupported(){ return 'Notification' in window; }
function requestNotifPermission(){
  return new Promise(resolve => {
    if(!notificationsSupported()){ resolve(false); return; }
    if(Notification.permission === 'granted'){ resolve(true); return; }
    if(Notification.permission === 'denied'){ resolve(false); return; }
    try{
      Notification.requestPermission().then(resolve).catch(()=> resolve(false));
    }catch(e){ resolve(false); }
  });
}
function notifySale(venta){
  if(!notificationsSupported()) return;
  if(!notifEnabled(currentModo)) return;
  if(!venta) return;
  if(Notification.permission !== 'granted'){
    // Las notificaciones vienen activadas de fábrica, pero el navegador pide
    // el permiso una sola vez: se solicita con este gesto del usuario (al
    // registrar la venta) si aún no fue concedido ni denegado.
    requestNotifPermission();
    return;
  }
  try{
    const total = (venta.total !== undefined && venta.total !== null) ? venta.total : 0;
    const cantidad = venta.cantidad || 1;
    const n = new Notification('💵 Nueva venta registrada', {
      body: (venta.nombre || 'Producto') + ' — ' + fmtMoney(total) + ' (x' + cantidad + ')'
    });
    n.onclick = ()=>{ try{ window.focus(); }catch(e){ /* ignorar */ } n.close(); };
  }catch(e){ /* ignorar */ }
}
// Compara las ventas antes/después de una sincronización remota y avisa las
// nuevas (ventas registradas en otro dispositivo).
function notifyNewRemoteSales(prevIds, newVentas){
  if(!notificationsSupported()) return;
  if(!notifEnabled(currentModo)) return;
  const prev = new Set(prevIds || []);
  (newVentas || []).forEach(v => {
    if(v && v.id && !prev.has(v.id)) notifySale(v);
  });
}

function passKeyFor(modo){ return 'stockferre_pass_' + modo + '_v1'; }

// Ofuscación simple (NO es seguridad real, solo evita que se vea la
// contraseña "a simple vista" en LocalStorage). Suficiente para separar el
// acceso entre los dos dueños del negocio.
function encodePass(pass){ return btoa(unescape(encodeURIComponent('sf::' + pass))); }

// La contraseña de cada modo se guarda DENTRO de la base de ese modo (campo
// _passEnc). Como la base se sincroniza por Firebase (ver saveDB/persistModoDB),
// la contraseña que pones en la PC también existe en el celular y al revés.
// La clave local antigua (passKeyFor) se conserva como respaldo y para migrar.
function getPassEnc(modo){
  try{
    const enc = loadModoDB(modo)._passEnc;
    if(enc) return enc;
  }catch(e){ /* ignorar */ }
  try{ return localStorage.getItem(passKeyFor(modo)); }catch(e){ return null; }
}
function hasPassword(modo){ return !!getPassEnc(modo); }
function setPassword(modo, pass){
  const enc = encodePass(pass);
  const dbObj = loadModoDB(modo);
  dbObj._passEnc = enc;
  persistModoDB(modo, dbObj);
  if(modo === currentModo && db) db._passEnc = enc; // para que saveDB() no la borre
  try{ localStorage.setItem(passKeyFor(modo), enc); }catch(e){}
}
function removePassword(modo){
  const dbObj = loadModoDB(modo);
  delete dbObj._passEnc;
  persistModoDB(modo, dbObj);
  if(modo === currentModo && db) delete db._passEnc; // para que saveDB() no la reescriba
  try{ localStorage.removeItem(passKeyFor(modo)); }catch(e){}
}
function checkPassword(modo, pass){
  return getPassEnc(modo) === encodePass(pass);
}

// Si el dueño ya tenía una contraseña en la clave local antigua, la pasa a la
// base del modo y la sube a Firebase una sola vez para que se sincronice a
// los demás celulares.
function migrateLegacyPasswords(){
  ['manual','electrico'].forEach(modo=>{
    try{
      const old = localStorage.getItem(passKeyFor(modo));
      if(!old) return;
      const dbObj = loadModoDB(modo);
      if(!dbObj._passEnc){
        dbObj._passEnc = old;
        persistModoDB(modo, dbObj);
        if(modo === currentModo && db) db._passEnc = old;
      }
    }catch(e){ /* ignorar */ }
  });
}

// Cambia la base de datos activa (LocalStorage + Firebase) al modo indicado.
// 'invitado' no se guarda como último modo: es una sesión temporal.
function switchModoData(modo){
  disconnectFirebase();
  disconnectGuestFirebase();
  currentModo = modo;
  if(modo !== 'invitado'){ try{ localStorage.setItem(MODO_KEY, modo); }catch(e){} }
  document.body.classList.remove('modo-manual', 'modo-electrico', 'modo-invitado');
  document.body.classList.add('modo-' + modo);
  loadDB();
  loadInvUpdates();
  setSyncStatus('local');
  updateSidebarBrand();
  updatePasswordButtonLabel();
  syncRememberSwitchUI();
  syncNotifSwitchUI();
  // Carga las imágenes locales de este modo (IndexedDB, no Firebase)
  loadImagesForModo(modo).then(()=> rerenderCurrentView());
  if(modo === 'invitado') connectGuestFirebase();
  else connectFirebase();
}

// Punto de entrada desde los botones de Inicio (🛠️ Manuales / ⚡ Eléctricas).
// Si ese modo tiene contraseña puesta, pide la contraseña antes de entrar;
// si no, entra directo como dueño (admin) — así es "por ahora".
function attemptEnterModo(modo){
  // Un invitado nunca puede "colarse" como dueño: si el modo no tiene
  // contraseña, no hay puerta por la que entrar como administrador.
  if(currentRole === 'guest'){
    if(hasPassword(modo)){
      openPasswordGate(modo);
    }else{
      toast('Este modo no tiene contraseña. Pídele la contraseña al dueño.', 'warning');
    }
    return;
  }
  // Sesión recordada en este dispositivo: entra directo como dueño, sin pedir
  // contraseña (solo afecta al dispositivo local).
  if(isRemembered(modo)){
    currentRole = 'admin';
    try{ localStorage.setItem(ROLE_KEY, 'admin'); }catch(e){}
    enterModo(modo);
    return;
  }
  if(hasPassword(modo)){
    openPasswordGate(modo);
  }else{
    currentRole = 'admin';
    try{ localStorage.setItem(ROLE_KEY, 'admin'); }catch(e){}
    enterModo(modo);
  }
}

// El invitado ya no elige a cuál app entrar: entra directo al menú de
// invitado, que combina los productos de Manuales y Eléctricas.
function enterModoAsGuest(){
  guestSessionScans = [];
  guestSessionSearches = [];
  guestSessionInventory = [];
  currentRole = 'guest';
  try{ localStorage.removeItem(ROLE_KEY); }catch(e){}
  enterModo('invitado');
}

function enterModo(modo){
  switchModoData(modo);
  applyRoleUI();
  showWelcomeForMode(modo);
  if(currentRole === 'guest'){
    toast('Entraste al modo invitado', 'success');
  }else{
    toast(`Entraste a ${MODO_LABELS[modo]}`, 'success');
  }
}

// Pantalla de bienvenida: se muestra al entrar a un modo, con el nombre en el
// color de ese modo (naranja/amarillo/verde). Conserva el menú lateral para
// navegar. Dura medio segundo y salta sola a la pestaña Productos.
function showWelcomeForMode(modo){
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-welcome').classList.add('active');
  const sub = modo === 'manual' ? 'Herramientas Manuales'
    : modo === 'electrico' ? 'Herramientas Eléctricas'
    : 'TIENDA 1';
  document.getElementById('welcomeSubtitle').textContent = sub;
  // Logo grande debajo del título: 🛠️ en Manuales, ⚡ en Eléctricas, y en el
  // Invitado los dos logos juntos (🛠️ ⚡) en una sola fila.
  const logoEl = document.getElementById('welcomeLogo');
  if(logoEl){
    logoEl.innerHTML = modo === 'manual' ? '<span>🛠️</span>'
      : modo === 'electrico' ? '<span>⚡</span>'
      : '<span>🛠️</span><span>⚡</span>';
  }
  document.querySelectorAll('.nav-item[data-view]').forEach(btn=> btn.classList.remove('active'));
  document.getElementById('viewTitle').textContent = sub;
  document.body.classList.remove('inicio-theme');
  document.body.classList.add('welcome-view');
  closeSidebarMobile();
  closeAllModals();
  restoreScannerBlockHome();
  scanContext = 'lookup';
  // Salto automático a la pestaña de productos tras medio segundo.
  if(welcomeTimer) clearTimeout(welcomeTimer);
  welcomeTimer = setTimeout(()=>{ welcomeTimer = null; showView('productos'); }, 500);
  // Sonido de ingreso de sesión al entrar a las pantallas de bienvenida
  setTimeout(playLoginSound, 350);
}

// Sonido de "ingreso de sesión" (el clásico timbre/chime de bienvenida),
// generado con Web Audio para no depender de archivos de audio.
function playLoginSound(){
  try{
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return;
    const ctx = new AC();
    if(ctx.state === 'suspended' && ctx.resume) ctx.resume();
    const now = ctx.currentTime;

    const tone = (freq, start, dur, vol) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      o.connect(g);
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0, now + start);
      g.gain.linearRampToValueAtTime(vol, now + start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      o.start(now + start);
      o.stop(now + start + dur + 0.05);
    };

    // Chime ascendente cálido estilo "inicio de sesión"
    tone(523.25, 0.00, 0.7, 0.35);  // Do5
    tone(659.25, 0.00, 0.7, 0.28);  // Mi5
    tone(783.99, 0.00, 0.7, 0.22);  // Sol5
    tone(1046.5, 0.10, 0.8, 0.15);  // Do6 (brillo final)
  }catch(e){}
}

// Sonido al apretar los botones del menú lateral (distinto al de ingreso de
// sesión), generado con Web Audio. Chime suave, similar al de la pantalla de
// inicio/bienvenida pero más corto y discreto.
function playClickSound(){
  try{
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return;
    const ctx = new AC();
    if(ctx.state === 'suspended' && ctx.resume) ctx.resume();
    const now = ctx.currentTime;

    const tone = (freq, start, dur, vol) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      o.connect(g);
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0, now + start);
      g.gain.linearRampToValueAtTime(vol, now + start + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      o.start(now + start);
      o.stop(now + start + dur + 0.05);
    };

    // Acorde mayor corto, en la línea del chime de bienvenida
    tone(523.25, 0.00, 0.25, 0.14);  // Do5
    tone(659.25, 0.00, 0.25, 0.12);  // Mi5
    tone(783.99, 0.00, 0.25, 0.10);  // Sol5
  }catch(e){}
}

// Sonido de venta registrada, generado con Web Audio. Arpegio ascendente
// suave y armónico (Cmaj7) con ondas puras: cálido y gentil con el oído,
// sin sonidos bruscos.
function playCashRegisterSound(){
  try{
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return;
    const ctx = new AC();
    if(ctx.state === 'suspended' && ctx.resume) ctx.resume();
    const now = ctx.currentTime;

    // Nota suave: onda seno, ataque lento, caída larga y serena
    const note = (freq, start, dur, vol) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      o.connect(g);
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0, now + start);
      g.gain.linearRampToValueAtTime(vol, now + start + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
      o.start(now + start);
      o.stop(now + start + dur + 0.05);
    };

    // Arpegio ascendente Cmaj7, cálido y armónico
    note(523.25,  0.00, 1.1, 0.16);  // Do5
    note(659.25,  0.10, 1.1, 0.14);  // Mi5
    note(783.99,  0.20, 1.2, 0.13);  // Sol5
    note(987.77,  0.30, 1.3, 0.12);  // Si5
    note(1046.50, 0.42, 1.5, 0.10);  // Do6
  }catch(e){}
}

function openPasswordGate(modo){
  pendingGateModo = modo;
  document.getElementById('gateModoLabel').textContent = MODO_LABELS[modo];
  const input = document.getElementById('gatePassInput');
  if(input) input.value = '';
  openModal('modalPasswordGate');
  setTimeout(()=>{ if(input) input.focus(); }, 150);
}

function applyRoleUI(){
  document.body.classList.toggle('role-guest', currentRole === 'guest');
}

// Restaura el modo guardado al abrir la app (sin pedir contraseña de nuevo:
// la contraseña solo se pide al elegir un modo desde Inicio). La app siempre
// abre como dueño en la pantalla principal: el modo invitado no se recuerda.
function restoreModo(){
  let modo = 'manual';
  try{ modo = localStorage.getItem(MODO_KEY) || 'manual'; }catch(e){}
  if(modo === 'invitado') modo = 'manual';
  currentModo = modo;
  currentRole = 'admin';
  document.body.classList.remove('modo-manual', 'modo-electrico', 'modo-invitado');
  document.body.classList.add('modo-' + modo);
  applyRoleUI();
}

function updateSidebarBrand(){
  const iconEl = document.querySelector('.sidebar-brand .brand-icon');
  const strongEl = document.querySelector('.sidebar-brand .brand-text strong');
  const smallEl = document.querySelector('.sidebar-brand .brand-text small');
  // Logo según el modo: Manuales usa la llave cruzada con martillo 🛠️,
  // Eléctricas el ⚡ amarillo, y el Invitado muestra los dos juntos.
  // En el Invitado los logos NO van arriba con las letras: se quitan de ahí y
  // se muestran debajo de las pestañas, apilados en vertical y centrados.
  if(iconEl){
    iconEl.innerHTML = currentModo === 'invitado' ? ''
      : (currentModo === 'manual' ? '🛠️' : '⚡');
  }
  const logosEl = document.getElementById('sidebarLogos');
  if(logosEl){
    logosEl.innerHTML = currentModo === 'invitado' ? '<span>🛠️</span><span>⚡</span>' : '';
  }
  if(strongEl) strongEl.textContent = MODO_LABELS[currentModo] || 'TIENDA 1';
  if(smallEl){
    // "Consulta de productos" desaparece en Manuales y Eléctricas; en el
    // Invitado se muestra "Modo invitado".
    if(currentRole === 'guest'){
      smallEl.textContent = '👤 Modo invitado';
      smallEl.style.display = '';
    }else if(currentModo === 'manual' || currentModo === 'electrico'){
      smallEl.textContent = '';
      smallEl.style.display = 'none';
    }else{
      smallEl.textContent = 'Consulta de productos';
      smallEl.style.display = '';
    }
  }
}

// El botón "🔒 Agregar contraseña" se muestra dentro de Manuales y Eléctricas
// (dueño), y no para invitados.
function updatePasswordButtonLabel(){
  const btn = document.getElementById('btnAddPassword');
  if(!btn) return;
  btn.textContent = hasPassword(currentModo) ? '🔒 Cambiar contraseña' : '🔒 Agregar contraseña';
}

function openSetPasswordModal(){
  document.getElementById('setPassModoLabel').textContent = MODO_LABELS[currentModo];
  document.getElementById('setPassInput').value = '';
  document.getElementById('setPassConfirm').value = '';
  document.getElementById('btnRemovePassword').style.display = hasPassword(currentModo) ? 'inline-block' : 'none';
  openModal('modalSetPassword');
}

function handleSetPasswordSubmit(e){
  e.preventDefault();
  const p1 = document.getElementById('setPassInput').value;
  const p2 = document.getElementById('setPassConfirm').value;
  if(p1.length < 4){ toast('La contraseña debe tener al menos 4 caracteres', 'error'); return; }
  if(p1 !== p2){ toast('Las contraseñas no coinciden', 'error'); return; }
  setPassword(currentModo, p1);
  toast(`Contraseña guardada para ${MODO_LABELS[currentModo]}`, 'success');
  updatePasswordButtonLabel();
  closeAllModals();
}

/* -------------------------------------------------------------------------
   11. MODALES / TOASTS / CONFIRMACIÓN
   ------------------------------------------------------------------------- */

function openModal(id){
  document.getElementById('modalBackdrop').classList.add('open');
  document.getElementById(id).classList.add('open');
}
// Cierra únicamente el modal indicado, sin tocar otros modales que puedan
// estar abiertos debajo (por ejemplo el escáner de código de barras, que se
// abre "encima" del recuadro de registrar inventario).
function closeModalById(id){
  const modal = document.getElementById(id);
  if(modal) modal.classList.remove('open');
  if(!document.querySelector('.modal.open')){
    document.getElementById('modalBackdrop').classList.remove('open');
  }
}
function closeAllModals(){
  const inventarioScanWasOpen = document.getElementById('modalInventarioScan').classList.contains('open');
  const barcodeScanWasOpen = document.getElementById('modalBarcodeScan').classList.contains('open');
  const ventaScanWasOpen = document.getElementById('modalVentaScan').classList.contains('open');
  const compraScanWasOpen = document.getElementById('modalCompraScan').classList.contains('open');
  document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open'));
  document.getElementById('modalBackdrop').classList.remove('open');
  if(inventarioScanWasOpen || ventaScanWasOpen || compraScanWasOpen){
    stopActiveScanner();
    restoreScannerBlockHome();
    scanContext = 'lookup';
  }
  if(barcodeScanWasOpen){
    stopBarcodeScanner();
  }
}

let confirmCallback = null;
function confirmDialog(title, message, onAccept){
  document.getElementById('confirmTitle').textContent = title;
  document.getElementById('confirmMessage').textContent = message;
  confirmCallback = onAccept;
  openModal('modalConfirm');
}

// Diálogo "¿Mantener inventario?" al borrar o vaciar ventas/compras:
//   onKeep    → Sí (el inventario NO se modifica).
//   onRestore → No (el inventario sí se modifica).
let ventaBorrarCallbacks = null;
function ventaBorrarDialog(title, message, onKeep, onRestore){
  if(title) document.getElementById('ventaBorrarTitle').textContent = title;
  document.getElementById('ventaBorrarMessage').textContent = message;
  ventaBorrarCallbacks = { onKeep, onRestore };
  openModal('modalVentaBorrar');
}

function toast(message, type){
  const container = document.getElementById('toastContainer');
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = message;
  container.appendChild(el);
  setTimeout(()=>{ el.remove(); }, 3200);
}

/* -------------------------------------------------------------------------
   12. ESCÁNER DE TEXTO / OCR (Tesseract.js)
   Lee códigos numéricos (12345) y alfanuméricos (HNV3445, TR1223, TR23-23)
   impresos en etiquetas, en tiempo real, sin tomar fotos.
   ------------------------------------------------------------------------- */

// Palabras que suelen aparecer junto al código en las etiquetas y deben ignorarse
const OCR_IGNORE_WORDS = [
  'NUEVO','NEW','OFERTA','DESCUENTO','EXCELENTE','EXC','IMPORTADO','IMPORT',
  'PROMO','PROMOCION','CALIDAD','GARANTIA','ORIGINAL','SALE','STOCK','PRECIO',
  'FERRETERIA','BOLIVIA','MARCA','MODELO','PROD','PRODUCTO'
];

// Dos modos de escaneo: numérico puro (más preciso para códigos como 17736)
// y alfanumérico (2-4 letras + 2-5 números, guion opcional, ej: HNV3445)
// Incluimos el espacio en el whitelist para que Tesseract separe correctamente
// el código de otros números/textos cercanos en la etiqueta (precio, marca, etc.)
const OCR_MODES = {
  numerico: {
    pattern: /^[0-9]{3,8}$/,
    whitelist: '0123456789 '
  },
  alfanumerico: {
    pattern: /^[A-Z]{2,4}[0-9]{2,5}(-[0-9]{2,4})?$/,
    whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789- '
  }
};

let scanCodeMode = 'numerico';

// El recuadro punteado en pantalla (CSS .ocr-guide) está definido como
// porcentajes del contenedor visible, pero el <video> se muestra con
// object-fit:cover (recorta y escala la imagen nativa de la cámara para
// llenar el contenedor). Si calculamos el recorte a analizar usando
// porcentajes directos sobre videoWidth/videoHeight, NO coincide con lo que
// el recuadro punteado muestra en pantalla — por eso "escaneaba todo lo que
// la cámara ve". Esta función calcula primero qué parte del video nativo es
// la que realmente se ve en el contenedor, y recién ahí aplica el porcentaje
// del recuadro sobre esa parte visible.
// IMPORTANTE: estos porcentajes deben coincidir con los de .ocr-guide en styles.css
const GUIDE_BOX = { left: 0.15, right: 0.15, top: 0.35, bottom: 0.35 };

function getGuideBoxCropRect(videoEl, box){
  box = box || GUIDE_BOX;
  const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
  const containerW = videoEl.clientWidth || vw;
  const containerH = videoEl.clientHeight || vh;

  // object-fit:cover -> la imagen se escala para cubrir el contenedor,
  // recortando el excedente en un solo eje
  const coverScale = Math.max(containerW / vw, containerH / vh);
  const visibleW = containerW / coverScale;
  const visibleH = containerH / coverScale;
  const offsetX = (vw - visibleW) / 2;
  const offsetY = (vh - visibleH) / 2;

  const boxW = visibleW * (1 - box.left - box.right);
  const boxH = visibleH * (1 - box.top - box.bottom);
  const boxX = offsetX + visibleW * box.left;
  const boxY = offsetY + visibleH * box.top;

  return { x: boxX, y: boxY, w: boxW, h: boxH };
}

const OCR_INTERVAL_MS = 250;

let ocrWorker = null;
let ocrWarmPromise = null; // promesa del precálculo del lector OCR (en segundo plano)
let ocrStream = null;
let ocrTimer = null;
let ocrBusy = false;
let ocrActive = false;
let ocrPaused = false; // true mientras se muestra/analiza una foto congelada

function cleanOcrToken(raw){
  return raw.toUpperCase().replace(/[^A-Z0-9-]/g,'').trim();
}

function extractCandidateCodes(text){
  if(!text) return [];
  const pattern = OCR_MODES[scanCodeMode].pattern;
  const tokens = text.split(/[\s\n\r,;:|]+/).map(cleanOcrToken).filter(Boolean);
  const seen = new Set();
  const candidates = [];
  tokens.forEach(tok=>{
    if(seen.has(tok)) return;
    seen.add(tok);
    if(OCR_IGNORE_WORDS.includes(tok)) return;
    if(pattern.test(tok)) candidates.push(tok);
  });
  return candidates;
}

function pickBestCandidate(candidates){
  if(candidates.length === 0) return null;
  const existing = candidates.find(c => getProductoByCodigo(c));
  if(existing) return existing;
  return candidates[0];
}

// Normaliza confusiones típicas de OCR entre letras y números parecidos
// (O/0, I/1, S/5, B/8, Z/2, G/6) para poder comparar "a ojo" contra los
// códigos ya guardados, incluso si el OCR leyó mal alguno de esos caracteres.
function normalizeForFuzzyMatch(str){
  return String(str||'').toUpperCase().replace(/[^A-Z0-9]/g,'')
    .replace(/O/g,'0').replace(/I/g,'1').replace(/S/g,'5')
    .replace(/B/g,'8').replace(/Z/g,'2').replace(/G/g,'6');
}

function findProductoFuzzy(token){
  if(!token || token.length < 3) return null;
  const norm = normalizeForFuzzyMatch(token);
  return db.productos.find(p => normalizeForFuzzyMatch(p.codigo) === norm) || null;
}

// Resuelve el mejor código a partir del texto leído por el OCR:
// 1) un candidato con forma válida que ya existe en la base
// 2) una corrección por confusión de caracteres (solo modo alfanumérico)
// 3) el primer candidato con forma válida (para poder crear el producto)
function resolveScannedText(text){
  const candidates = extractCandidateCodes(text);
  const exactExisting = candidates.find(c => getProductoByCodigo(c));
  if(exactExisting) return exactExisting;

  if(scanCodeMode === 'alfanumerico'){
    const tokens = String(text||'').split(/[\s\n\r,;:|]+/).map(cleanOcrToken).filter(Boolean);
    for(const tok of tokens){
      if(OCR_IGNORE_WORDS.includes(tok)) continue;
      const fuzzyMatch = findProductoFuzzy(tok);
      if(fuzzyMatch) return fuzzyMatch.codigo;
    }
  }

  return candidates[0] || null;
}

function setOcrStatus(msg){
  const el = document.getElementById('ocrStatus');
  if(el) el.textContent = msg;
}

let ocrStarting = false;

// Precalienta Tesseract en segundo plano (poco después de cargar la app):
// la primera vez que se usa el escáner, Tesseract tiene que descargar el
// idioma (~10MB) y levantar el worker, y eso es lo que hace que "se quede
// en buscando código" la primera vez. Al precargarlo, el primer escaneo
// detecta al instante porque el motor ya está listo.
function warmupOcrWorker(){
  if(ocrWarmPromise || ocrWorker || ocrActive || typeof Tesseract === 'undefined') return;
  ocrWarmPromise = (async()=>{
    const w = await Tesseract.createWorker('eng');
    await w.setParameters({
      tessedit_char_whitelist: OCR_MODES[scanCodeMode].whitelist,
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1'
    });
    ocrWorker = w;
  })().catch(err=>{
    console.warn('Precálculo del OCR falló (se reintenta al abrir el escáner)', err);
    ocrWorker = null;
    ocrWarmPromise = null;
  });
}

async function startOcrScanner(){
  if(ocrActive || ocrStarting) return;
  ensureAudioCtx(); // desbloquea el audio dentro del gesto que abrió la cámara
  ocrStarting = true;

  if(typeof Tesseract === 'undefined'){
    setOcrStatus('No se pudo cargar Tesseract.js. Verifica tu conexión a internet o usa la búsqueda manual.');
    ocrStarting = false;
    return;
  }

  const videoEl = document.getElementById('ocrVideo');

  try{
    setOcrStatus('Iniciando cámara...');
    ocrStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });
    videoEl.srcObject = ocrStream;
    await videoEl.play();
  }catch(err){
    console.warn(err);
    setOcrStatus('No se pudo acceder a la cámara. Verifica los permisos del navegador o usa la búsqueda manual.');
    ocrStarting = false;
    return;
  }

  try{
    setOcrStatus('Preparando el lector de texto...');
    if(!ocrWorker){
      // Si el precálculo ya estaba en marcha, espera a que termine en vez
      // de descargar el idioma dos veces a la vez.
      if(ocrWarmPromise){ try{ await ocrWarmPromise; }catch(e){ /* se reintenta abajo */ } }
      if(!ocrWorker){ ocrWorker = await Tesseract.createWorker('eng'); }
    }
    await ocrWorker.setParameters({
      tessedit_char_whitelist: OCR_MODES[scanCodeMode].whitelist,
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1'
    });
  }catch(err){
    console.warn(err);
    setOcrStatus('No se pudo iniciar el motor de lectura de texto. Verifica tu conexión a internet.');
    ocrStarting = false;
    return;
  }

  ocrActive = true;
  ocrStarting = false;
  setOcrStatus('🔎 Buscando código...');
  scheduleNextOcrCapture();
}

function scheduleNextOcrCapture(){
  if(!ocrActive || ocrPaused) return;
  ocrTimer = setTimeout(runOcrCapture, OCR_INTERVAL_MS);
}

// Convierte el recorte a blanco y negro (umbral) para que Tesseract lea
// mucho mejor las etiquetas fotografiadas con la cámara del celular.
// Escala de grises + realce de contraste (sin forzar blanco/negro puro).
// Un umbral fijo puede "borrar" el texto por completo con luz de tienda
// desigual; Tesseract ya aplica su propia binarización adaptativa internamente,
// así que aquí solo le damos una imagen de mayor contraste para ayudarlo.
function preprocessCanvas(canvas){
  const ctx = canvas.getContext('2d');
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imgData.data;
  const n = canvas.width * canvas.height;

  const gray = new Uint8ClampedArray(n);
  let min = 255, max = 0;
  for(let i = 0, j = 0; i < d.length; i += 4, j++){
    const g = 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
    gray[j] = g;
    if(g < min) min = g;
    if(g > max) max = g;
  }

  const range = Math.max(max - min, 1); // evita división por cero en imágenes planas
  for(let i = 0, j = 0; i < d.length; i += 4, j++){
    const stretched = ((gray[j] - min) / range) * 255;
    d[i] = d[i+1] = d[i+2] = stretched;
  }
  ctx.putImageData(imgData, 0, 0);
}

async function runOcrCapture(){
  if(!ocrActive || ocrBusy || ocrPaused) return;
  const videoEl = document.getElementById('ocrVideo');
  const canvasEl = document.getElementById('ocrCanvas');
  if(!videoEl || !videoEl.videoWidth){ scheduleNextOcrCapture(); return; }

  ocrBusy = true;
  try{
    // Recorta exactamente lo que se ve dentro del recuadro punteado (~5cm de distancia)
    const crop = getGuideBoxCropRect(videoEl);

    // Escala el recorte para el OCR: los códigos son pequeños en la imagen
    // original y una imagen más grande mejora la precisión, pero una imagen
    // gigante también hace que Tesseract tarde más por fotograma. 1.7x es un
    // punto medio bueno: rápido de analizar y legible en la mayoría de etiquetas.
    const scale = 1.7;
    canvasEl.width = crop.w * scale;
    canvasEl.height = crop.h * scale;
    const ctx = canvasEl.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(videoEl, crop.x, crop.y, crop.w, crop.h, 0, 0, canvasEl.width, canvasEl.height);
    preprocessCanvas(canvasEl);

    setOcrStatus('🔎 Analizando etiqueta...');
    const { data: { text } } = await ocrWorker.recognize(canvasEl);
    if(ocrPaused) return; // se tomó una foto manual mientras se analizaba este fotograma: descartar
    const best = resolveScannedText(text);

    if(best){
      const now = Date.now();
      if(!(window.__lastOcrCode === best && now - (window.__lastOcrTime||0) < 3000)){
        window.__lastOcrCode = best;
        window.__lastOcrTime = now;
        playOcrBeep();
        handleScannedCode(best, true);
      }
      if(ocrActive) setOcrStatus('✅ Código detectado: ' + best);
    }else if(ocrActive){
      // Muestra lo último que "vio" el OCR (aunque no coincida) para poder
      // ajustar el encuadre o diagnosticar si el motor no está leyendo nada.
      const raw = String(text||'').replace(/\s+/g,' ').trim();
      if(raw){
        setOcrStatus('🔎 Leyendo: "' + raw.slice(0,28) + '" — buscando código...');
      }else{
        setOcrStatus('🔎 Buscando código... (acerca más la etiqueta o mejora la luz)');
      }
    }
  }catch(err){
    console.warn('Error de OCR', err);
  }finally{
    ocrBusy = false;
    scheduleNextOcrCapture();
  }
}

// Captura un único fotograma (más grande y con más margen que el recorte
// continuo) y lo analiza con calma. Al tocar el botón, el usuario deja de
// mover el celular justo en ese instante, así que sale mucho más nítido
// que un fotograma tomado en movimiento durante el escaneo continuo.
async function captureShot(){
  if(!ocrActive || !ocrWorker) return;
  const videoEl = document.getElementById('ocrVideo');
  const canvasEl = document.getElementById('ocrCanvas');
  const frozenImg = document.getElementById('ocrFrozenImg');
  if(!videoEl || !videoEl.videoWidth) return;

  // Pausa el escaneo continuo y congela la imagen DE INMEDIATO, sin esperar
  // a que termine un análisis en curso (si lo había) — así el botón responde
  // al instante en vez de parecer que "no hace nada".
  ocrPaused = true;
  if(ocrTimer){ clearTimeout(ocrTimer); ocrTimer = null; }

  // Usa el mismo recuadro punteado que se ve en pantalla: lo que captura
  // debe ser exactamente lo que el usuario ve encuadrado, ni más ni menos.
  const crop = getGuideBoxCropRect(videoEl);
  const scale = 2.2;
  canvasEl.width = crop.w * scale;
  canvasEl.height = crop.h * scale;
  const ctx = canvasEl.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(videoEl, crop.x, crop.y, crop.w, crop.h, 0, 0, canvasEl.width, canvasEl.height);

  // Muestra la foto congelada (antes del preprocesamiento) para dar la sensación de "captura"
  frozenImg.src = canvasEl.toDataURL('image/jpeg', 0.85);
  frozenImg.classList.add('visible');
  document.getElementById('btnCaptureShot').style.display = 'none';
  document.getElementById('btnResumeLive').style.display = '';
  setOcrStatus('📸 Foto capturada. Analizando...');

  ocrBusy = true;
  try{
    preprocessCanvas(canvasEl);
    // recognize() se encola automáticamente si el motor todavía estaba
    // procesando un fotograma del escaneo continuo; no hace falta esperar aquí.
    const { data: { text } } = await ocrWorker.recognize(canvasEl);
    const best = resolveScannedText(text);

    if(best){
      playOcrBeep();
      handleScannedCode(best, true);
      setOcrStatus('✅ Código detectado: ' + best);
    }else{
      const raw = String(text || '').replace(/\s+/g,' ').trim();
      setOcrStatus(raw
        ? '⚠️ No coincide ningún código. Se leyó: "' + raw.slice(0,28) + '"'
        : '⚠️ No se detectó texto legible. Intenta de nuevo o cambia de modo (numérico/alfanumérico).');
    }
  }catch(err){
    console.warn('Error al capturar foto', err);
    setOcrStatus('No se pudo analizar la foto. Intenta de nuevo.');
  }finally{
    ocrBusy = false;
  }
}

function resumeLiveScan(){
  ocrPaused = false;
  const frozenImg = document.getElementById('ocrFrozenImg');
  frozenImg.classList.remove('visible');
  frozenImg.removeAttribute('src');
  document.getElementById('btnCaptureShot').style.display = '';
  document.getElementById('btnResumeLive').style.display = 'none';
  if(ocrActive){
    setOcrStatus('🔎 Buscando código...');
    scheduleNextOcrCapture();
  }
}

function stopOcrScanner(){
  ocrActive = false;
  ocrStarting = false;
  ocrPaused = false;
  if(ocrTimer){ clearTimeout(ocrTimer); ocrTimer = null; }
  if(ocrStream){
    ocrStream.getTracks().forEach(t => t.stop());
    ocrStream = null;
  }
  const videoEl = document.getElementById('ocrVideo');
  if(videoEl) videoEl.srcObject = null;
  if(ocrWorker){
    const w = ocrWorker;
    ocrWorker = null;
    w.terminate().catch(()=>{});
  }
  const frozenImg = document.getElementById('ocrFrozenImg');
  if(frozenImg){ frozenImg.classList.remove('visible'); frozenImg.removeAttribute('src'); }
  const btnCapture = document.getElementById('btnCaptureShot');
  const btnResume = document.getElementById('btnResumeLive');
  if(btnCapture) btnCapture.style.display = '';
  if(btnResume) btnResume.style.display = 'none';
  setOcrStatus('Iniciando cámara...');
}

// Escaneo en vivo de código de barras (ZXing) reutilizando el mismo
// contenedor de cámara ("ocr-reader") que los modos numérico/alfanumérico
// (Tesseract). Es el tercer modo del escáner principal, y como el bloque
// del escáner se comparte entre la pestaña "Escanear" y el registro de
// cantidad de inventario, funciona igual en los dos lugares.
let zxingLiveReader = null;
let zxingLiveActive = false;

async function startZxingLiveScanner(){
  if(zxingLiveActive) return;
  ensureAudioCtx(); // desbloquea el audio dentro del gesto que abrió la cámara
  if(typeof ZXing === 'undefined'){
    setOcrStatus('No se pudo cargar el lector de códigos de barras (revisa tu conexión a internet).');
    return;
  }
  zxingLiveActive = true;
  setOcrStatus('Iniciando cámara...');
  try{
    zxingLiveReader = new ZXing.BrowserMultiFormatReader();
    let deviceId;
    try{
      const devices = await ZXing.BrowserCodeReader.listVideoInputDevices();
      const back = devices.find(d => /back|rear|trasera|environment/i.test(d.label));
      deviceId = (back || devices[devices.length - 1] || {}).deviceId;
    }catch(e){ /* si falla la lista, ZXing usa la cámara por defecto */ }

    await zxingLiveReader.decodeFromVideoDevice(deviceId, 'ocrVideo', (result, err)=>{
      if(!zxingLiveActive || !result) return;
      const code = result.getText();
      const now = Date.now();
      if(!(window.__lastOcrCode === code && now - (window.__lastOcrTime||0) < 3000)){
        window.__lastOcrCode = code;
        window.__lastOcrTime = now;
        playBarcodeBeep();
        handleScannedCode(code, true);
      }
      if(zxingLiveActive) setOcrStatus('✅ Código de barras detectado: ' + code);
    });
    setOcrStatus('🔎 Buscando código de barras...');
  }catch(err){
    console.warn('Error al iniciar el escáner de código de barras', err);
    setOcrStatus('No se pudo acceder a la cámara. Verifica los permisos del navegador o usa la búsqueda manual.');
    zxingLiveActive = false;
  }
}

function stopZxingLiveScanner(){
  zxingLiveActive = false;
  if(zxingLiveReader){
    try{ zxingLiveReader.reset(); }catch(e){ /* ignorar */ }
    zxingLiveReader = null;
  }
  const videoEl = document.getElementById('ocrVideo');
  if(videoEl) videoEl.srcObject = null;
}

// Envoltorios: arrancan/paran el mecanismo de cámara correcto según el modo
// de escaneo activo (Tesseract para numérico/alfanumérico, ZXing para
// código de barras), sin que el resto del código tenga que saber cuál es.
function startActiveScanner(){
  if(scanCodeMode === 'codigobarras') startZxingLiveScanner();
  else startOcrScanner();
}
function stopActiveScanner(){
  stopOcrScanner();
  stopZxingLiveScanner();
}

async function setScanCodeMode(mode){
  if(mode === scanCodeMode) return;
  if(mode !== 'codigobarras' && !OCR_MODES[mode]) return;

  // Cambiar desde/hacia código de barras usa un mecanismo de cámara distinto
  // (ZXing en vez de Tesseract), así que ahí sí hace falta reiniciar la
  // cámara. Entre numérico y alfanumérico se mantiene la cámara encendida y
  // solo se actualiza la lista de caracteres permitidos.
  const switchingEngine = (mode === 'codigobarras') || (scanCodeMode === 'codigobarras');
  const wasActive = ocrActive || zxingLiveActive;

  if(switchingEngine && wasActive) stopActiveScanner();

  scanCodeMode = mode;
  document.querySelectorAll('[data-scan-code-mode]').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.scanCodeMode === mode);
  });
  const captureRow = document.querySelector('.scan-capture-row');
  if(captureRow) captureRow.style.display = (mode === 'codigobarras') ? 'none' : '';

  if(switchingEngine){
    if(wasActive) startActiveScanner();
  }else if(ocrWorker){
    // Si el lector Tesseract ya está activo, actualiza el whitelist de
    // caracteres sin reiniciar la cámara
    try{
      await ocrWorker.setParameters({ tessedit_char_whitelist: OCR_MODES[mode].whitelist });
    }catch(err){ console.warn(err); }
  }
}

/* -------------------------------------------------------------------------
   12b. ESCÁNER DE CÓDIGO DE BARRAS (ZXing) — solo para el botón 📷 del
   campo "Código de barras" en el registro de inventario. No toca ni
   comparte nada con el escáner OCR de texto (Tesseract).
   ------------------------------------------------------------------------- */

let bcReader = null;
let bcActive = false;

function setBcStatus(msg){
  const el = document.getElementById('bcStatus');
  if(el) el.textContent = msg;
}

async function startBarcodeScanner(){
  ensureAudioCtx(); // desbloquea el audio dentro del gesto que abrió la cámara
  if(typeof ZXing === 'undefined'){
    setBcStatus('No se pudo cargar el lector de códigos de barras (revisa tu conexión a internet).');
    return;
  }
  try{
    bcActive = true;
    setBcStatus('Iniciando cámara...');
    bcReader = new ZXing.BrowserMultiFormatReader();
    let deviceId;
    try{
      const devices = await ZXing.BrowserCodeReader.listVideoInputDevices();
      const back = devices.find(d => /back|rear|trasera|environment/i.test(d.label));
      deviceId = (back || devices[devices.length - 1] || {}).deviceId;
    }catch(e){ /* si falla la lista, ZXing usa la cámara por defecto */ }

    await bcReader.decodeFromVideoDevice(deviceId, 'bcVideo', (result, err)=>{
      if(!bcActive) return;
      if(result){
        const code = result.getText();
        playBarcodeBeep();
        stopBarcodeScanner();
        // Solo cierra el recuadro de la cámara de código de barras: el recuadro
        // de "Registrar inventario" (cantidad / código de barras) debe seguir
        // abierto detrás, con el campo ya lleno, listo para tocar "Registrar".
        closeModalById('modalBarcodeScan');
        const input = document.getElementById('invCodigoBarras');
        if(input) input.value = code;
        toast('Código de barras detectado: ' + code, 'success');
      }
      // Los errores de "no se encontró código en este frame" son normales
      // mientras se busca, así que se ignoran.
    });
    setBcStatus('🔎 Buscando código de barras...');
  }catch(err){
    console.error('Error al iniciar el escáner de código de barras', err);
    setBcStatus('No se pudo acceder a la cámara.');
  }
}

function stopBarcodeScanner(){
  bcActive = false;
  if(bcReader){
    try{ bcReader.reset(); }catch(e){ /* ignorar */ }
    bcReader = null;
  }
  const videoEl = document.getElementById('bcVideo');
  if(videoEl) videoEl.srcObject = null;
}

function openBarcodeScanModal(){
  openModal('modalBarcodeScan');
  startBarcodeScanner();
}

/* -------------------------------------------------------------------------
   13. EVENTOS / INICIALIZACIÓN
   ------------------------------------------------------------------------- */

function setupEventListeners(){
  // Navegación
  document.querySelectorAll('.nav-item[data-view]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      showView(btn.dataset.view);
    });
  });

  // Sonido de clic al apretar cualquier botón del menú lateral.
  document.getElementById('sidebar').addEventListener('click', (e)=>{
    if(e.target.closest('button')) playClickSound();
  });

  // Botón "Opciones": abre/cierra el panel inferior del menú (productos,
  // estado de sincronización, contraseña, volver al inicio, sesión y avisos).
  document.getElementById('btnToggleOptions').addEventListener('click', ()=>{
    document.getElementById('sidebarOptions').classList.toggle('open');
  });

  // "CAMBIO" en Ajuste de cuentas: al modificarlo, la suma del día que se ve
  // pasa a empezar desde ese monto en vez de cero. Se guarda por día.
  document.getElementById('ajusteCambio').addEventListener('change', (e)=>{
    setCambioBase(parseFloat(e.target.value) || 0, ventaFilterDateKey() || dateKeyOffset(0));
    renderAjusteCuentas(ventasFiltradas());
  });

  // Sidebar móvil
  document.getElementById('hamburgerBtn').addEventListener('click', ()=>{
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebarOverlay').classList.add('open');
  });
  document.getElementById('sidebarOverlay').addEventListener('click', closeSidebarMobile);

  // Botones de Inicio: Herramientas Manuales (naranja) / Herramientas Eléctricas (amarillo) / Invitado (verde)
  document.getElementById('btnModoManual').addEventListener('click', ()=> attemptEnterModo('manual'));
  document.getElementById('btnModoElectrico').addEventListener('click', ()=> attemptEnterModo('electrico'));
  document.getElementById('btnModoInvitado').addEventListener('click', ()=> enterModoAsGuest());

  // Botón casita (arriba, junto al nombre de la tienda): regresa a la pantalla
  // principal como dueño (admin). Si no, quedaba el rol de invitado y después
  // no se podía entrar a Manuales/Eléctricas desde Inicio.
  document.getElementById('btnHome').addEventListener('click', ()=>{
    stopActiveScanner();
    currentRole = 'admin';
    try{ localStorage.setItem(ROLE_KEY, 'admin'); }catch(e){}
    applyRoleUI();
    showView('inicio');
  });

  // Puerta de contraseña al entrar a un modo que tiene contraseña puesta
  document.getElementById('formPasswordGate').addEventListener('submit', (e)=>{
    e.preventDefault();
    const val = document.getElementById('gatePassInput').value;
    if(checkPassword(pendingGateModo, val)){
      currentRole = 'admin';
      try{ localStorage.setItem(ROLE_KEY, 'admin'); }catch(err){}
      closeAllModals();
      enterModo(pendingGateModo);
    }else{
      toast('Contraseña incorrecta', 'error');
    }
  });
  document.getElementById('btnGateAsGuest').addEventListener('click', ()=>{
    closeAllModals();
    enterModoAsGuest();
  });

  // "Mantener sesión abierta": no pedir contraseña en este dispositivo
  document.getElementById('rememberSwitch').addEventListener('change', (e)=>{
    if(currentModo === 'invitado') return;
    setRememberedMode(currentModo, e.target.checked);
    toast(e.target.checked
      ? 'Sesión abierta: ya no pedirá contraseña en este dispositivo'
      : 'Se pedirá contraseña al entrar en este dispositivo', 'success');
  });

  // "Activar notificaciones": avisar al registrarse una venta
  document.getElementById('notifySwitch').addEventListener('change', async (e)=>{
    if(currentModo === 'invitado') return;
    if(e.target.checked){
      if(!notificationsSupported()){
        e.target.checked = false;
        toast('Este navegador no soporta notificaciones', 'error');
        return;
      }
      if(Notification.permission === 'denied'){
        e.target.checked = false;
        toast('Notificaciones bloqueadas. Actívalas en la configuración del navegador.', 'error');
        return;
      }
      const ok = await requestNotifPermission();
      if(!ok){
        e.target.checked = false;
        toast('No se pudo activar las notificaciones', 'error');
        return;
      }
      setNotifEnabled(currentModo, true);
      toast('Notificaciones activadas', 'success');
      notifySale({ nombre: 'Notificaciones activadas', total: 0, cantidad: 1 });
    }else{
      setNotifEnabled(currentModo, false);
      toast('Notificaciones desactivadas', 'success');
    }
  });

  // Pestaña "👑 Modo Pro": abre/cierra el submenú (Estado Financiero / Pagos /
  // Deudas) que se desliza hacia abajo. La paleta de colores solo cambia el
  // tema (blanco, negro, naranjado, amarillo), sin tocar las pestañas.
  document.getElementById('proToggle').addEventListener('click', toggleProMode);
  document.getElementById('themePalette').addEventListener('click', (e)=>{
    const sw = e.target.closest('.palette-swatch');
    if(!sw) return;
    applyTheme(sw.dataset.theme, true);
  });

  // Agregar/cambiar/quitar contraseña (dentro de Manuales y Eléctricas)
  document.getElementById('btnAddPassword').addEventListener('click', openSetPasswordModal);
  document.getElementById('formSetPassword').addEventListener('submit', handleSetPasswordSubmit);
  document.getElementById('btnRemovePassword').addEventListener('click', ()=>{
    confirmDialog('Quitar contraseña', `¿Seguro que quieres quitar la contraseña de ${MODO_LABELS[currentModo]}?`, ()=>{
      removePassword(currentModo);
      toast('Contraseña eliminada', 'success');
      updatePasswordButtonLabel();
      closeAllModals();
    });
  });

  // Cerrar modales
  document.querySelectorAll('[data-close-modal]').forEach(btn=>{
    btn.addEventListener('click', closeAllModals);
  });
  document.getElementById('modalBackdrop').addEventListener('click', closeAllModals);

  // Confirm modal
  document.getElementById('confirmAcceptBtn').addEventListener('click', ()=>{
    if(confirmCallback) confirmCallback();
    confirmCallback = null;
    closeAllModals();
  });

  // Escáner
  document.querySelectorAll('[data-scan-code-mode]').forEach(btn=>{
    btn.addEventListener('click', ()=> setScanCodeMode(btn.dataset.scanCodeMode));
  });
  document.getElementById('btnCaptureShot').addEventListener('click', captureShot);
  document.getElementById('btnResumeLive').addEventListener('click', resumeLiveScan);
  document.getElementById('btnManualCodeGo').addEventListener('click', ()=>{
    const val = document.getElementById('manualCodeInput').value.trim();
    if(val) handleScannedCode(val);
  });
  document.getElementById('manualCodeInput').addEventListener('keydown', (e)=>{
    if(e.key === 'Enter'){
      e.preventDefault();
      const val = e.target.value.trim();
      if(val) handleScannedCode(val);
    }
  });

  // Productos
  document.getElementById('btnNewProduct').addEventListener('click', ()=> openProductModal());
  document.getElementById('btnExportProducts').addEventListener('click', exportProductosExcel);
  document.getElementById('formProducto').addEventListener('submit', handleProductSubmit);
  document.getElementById('prodSearch').addEventListener('input', renderProductos);
  document.getElementById('prodSearch').addEventListener('change', (e)=>{
    logSearchHistory(e.target.value);
  });
  document.getElementById('prodFilterCategoria').addEventListener('change', renderProductos);
  document.querySelector('#productsTable tbody').addEventListener('click', (e)=>{
    const editId = e.target.closest('[data-edit-product]')?.dataset.editProduct;
    const delId = e.target.closest('[data-delete-product]')?.dataset.deleteProduct;
    const imgId = e.target.closest('[data-img-product]')?.dataset.imgProduct;
    if(editId) openProductModal(getProductoById(editId));
    if(delId) deleteProducto(delId);
    if(imgId) openImageModal(imgId);
    // Clic en cualquier parte de la fila (que no sea un botón/imagen) abre la
    // ventana de características del producto.
    if(!editId && !delId && !imgId){
      const row = e.target.closest('tr[data-product-id]');
      if(row) openProductDetails(row.dataset.productId);
    }
  });

  // Imagen del producto (local, no Firebase): tomar foto / subir / web
  document.getElementById('btnImgTakePhoto').addEventListener('click', ()=> document.getElementById('fileImgCamera').click());
  document.getElementById('btnImgUploadDevice').addEventListener('click', ()=> document.getElementById('fileImgGallery').click());
  document.getElementById('btnImgLoadUrl').addEventListener('click', handleImgUrl);
  document.getElementById('imgUrlInput').addEventListener('keydown', (e)=>{
    if(e.key === 'Enter'){ e.preventDefault(); handleImgUrl(); }
  });
  document.getElementById('btnImgRemove').addEventListener('click', removeCurrentImage);
  // Carrusel de fotos del modal de imagen: deslizar, flechas y puntos. Se
  // protegen con existencias para que una versión vieja de la página en caché
  // no rompa el arranque de la app.
  const imgCarousel = document.getElementById('imgPreview');
  if(imgCarousel) imgCarousel.addEventListener('scroll', ()=> requestAnimationFrame(updateImgIndicator));
  const imgPrevBtn = document.getElementById('btnImgPrev');
  if(imgPrevBtn) imgPrevBtn.addEventListener('click', ()=> slideImgCarousel(-1));
  const imgNextBtn = document.getElementById('btnImgNext');
  if(imgNextBtn) imgNextBtn.addEventListener('click', ()=> slideImgCarousel(1));
  const imgDots = document.getElementById('imgPreviewDots');
  if(imgDots && imgCarousel){
    imgDots.addEventListener('click', (e)=>{
      const dot = e.target.closest('.carousel-dot');
      if(!dot) return;
      const imgs = imgCarousel.querySelectorAll('img');
      const idx = parseInt(dot.dataset.index || '0', 10);
      if(imgs[idx]) imgCarousel.scrollTo({ left: imgs[idx].getBoundingClientRect().left - imgCarousel.getBoundingClientRect().left + imgCarousel.scrollLeft, behavior: 'smooth' });
    });
  }
  // Contador del carrusel de fotos del modal de detalles.
  const detImgEl = document.getElementById('detImg');
  if(detImgEl) detImgEl.addEventListener('scroll', ()=> requestAnimationFrame(updateDetImgCounter));
  // Busca la foto del producto en Google Imágenes usando código + marca
  document.getElementById('btnImgWebSearch').addEventListener('click', ()=>{
    const p = imgTargetId ? getProductoById(imgTargetId) : null;
    if(!p) return;
    const query = [p.codigo, p.marca].filter(Boolean).join(' ');
    if(!query){ toast('El producto no tiene código', 'error'); return; }
    window.open('https://www.google.com/search?q=' + encodeURIComponent(query) + '&tbm=isch', '_blank', 'noopener');
  });
  document.getElementById('btnDetSaveCaract').addEventListener('click', saveDetCaracteristicas);
  document.getElementById('btnDetVerIngresos').addEventListener('click', ()=> openProductIngresos(detTargetId));
  document.getElementById('fileImgCamera').addEventListener('change', (e)=>{
    if(e.target.files[0]) handleImgFile(e.target.files[0]);
    e.target.value = '';
  });
  document.getElementById('fileImgGallery').addEventListener('change', (e)=>{
    if(e.target.files[0]) handleImgFile(e.target.files[0]);
    e.target.value = '';
  });

  // Categorías
  document.getElementById('btnAddCategory').addEventListener('click', ()=>{
    const input = document.getElementById('newCategoryInput');
    const val = input.value.trim();
    if(!val){ toast('Escribe un nombre de categoría', 'error'); return; }
    upsertCategoria(val);
    saveDB();
    input.value = '';
    renderCategorias();
    toast('Categoría agregada', 'success');
  });

  // Ventas
  document.getElementById('btnNuevaVenta').addEventListener('click', openNuevaVentaModal);
  document.getElementById('btnVentaScan').addEventListener('click', ()=>{
    closeAllModals();
    openVentaScan();
  });
  document.getElementById('btnCloseVentaScan').addEventListener('click', closeVentaScan);
  document.getElementById('btnExportVentas').addEventListener('click', exportVentasCSV);
  document.getElementById('btnImportVentas').addEventListener('click', ()=> document.getElementById('fileImportVentas').click());
  document.getElementById('fileImportVentas').addEventListener('change', (e)=>{
    if(e.target.files[0]) importVentasCSV(e.target.files[0]);
    e.target.value = '';
  });
  document.getElementById('btnPurgeVentas').addEventListener('click', ()=>{
    confirmDialog('Borrar ventas antiguas', '¿Borrar las ventas de hace más de 3 meses? Se recomienda exportarlas antes con "Exportar CSV". El stock de los productos no se modifica.', ()=>{
      purgeVentasAntiguas();
    });
  });
  document.getElementById('btnVaciarVentas').addEventListener('click', vaciarHistorialVentas);
  document.getElementById('ventaBorrarKeepBtn').addEventListener('click', ()=>{
    const cb = ventaBorrarCallbacks;
    ventaBorrarCallbacks = null;
    if(cb && cb.onKeep) cb.onKeep();
    closeAllModals();
  });
  document.getElementById('ventaBorrarRestoreBtn').addEventListener('click', ()=>{
    const cb = ventaBorrarCallbacks;
    ventaBorrarCallbacks = null;
    if(cb && cb.onRestore) cb.onRestore();
    closeAllModals();
  });
  document.getElementById('ventasDates').addEventListener('click', (e)=>{
    const chip = e.target.closest('.venta-date-chip');
    if(!chip) return;
    ventaDateFilter = chip.dataset.ventaDate;
    renderVentas();
  });
  document.getElementById('ventaDateInput').addEventListener('change', (e)=>{
    ventaDateFilter = e.target.value || 'todas';
    renderVentas();
  });
  document.getElementById('ajusteQrDetalle').addEventListener('click', (e)=>{
    const chip = e.target.closest('[data-qr-persona]');
    if(!chip) return;
    openQrHistorial(chip.dataset.qrPersona);
  });
  document.getElementById('formGastoPrestamo').addEventListener('submit', (e)=>{
    e.preventDefault();
    const bs = parseFloat(document.getElementById('gpBs').value);
    if(!bs || bs <= 0){ toast('Ingresa un monto en Bs', 'error'); return; }
    addGastoPrestamo({
      bs: bs,
      observacion: document.getElementById('gpObs').value.trim()
    });
    document.getElementById('gpBs').value = '';
    document.getElementById('gpObs').value = '';
    toast('Gasto/préstamo agregado', 'success');
  });
  document.getElementById('gastosPrestamosList').addEventListener('click', (e)=>{
    const dot = e.target.closest('[data-gp-modo]');
    if(dot){ toggleGastoPrestamoModo(dot.dataset.gpModo); return; }
    const del = e.target.closest('[data-delete-gp]');
    if(del){ deleteGastoPrestamo(del.dataset.deleteGp); return; }
    const chk = e.target.closest('[data-gp-ajustar]');
    if(chk) toggleGastoPrestamoAjustar(chk.dataset.gpAjustar);
  });
  document.getElementById('exportReminder').addEventListener('click', (e)=>{
    if(e.target.id === 'btnExportNow'){
      exportVentasCSV();
      markExportPrompt();
      maybeShowExportReminder();
    }else if(e.target.id === 'btnDismissExport'){
      markExportPrompt();
      maybeShowExportReminder();
    }
  });
  document.getElementById('ventaSearchInput').addEventListener('input', renderVentaSearchResults);
  document.getElementById('ventaSearchResults').addEventListener('click', (e)=>{
    const id = e.target.closest('[data-venta-select]')?.dataset.ventaSelect;
    if(!id) return;
    const p = getProductoById(id);
    closeAllModals();
    if(p) openVentaModal(p);
  });
  document.getElementById('btnVentaOtro').addEventListener('click', ()=>{
    closeAllModals();
    openVentaModalOtro();
  });
  document.getElementById('formVenta').addEventListener('submit', handleVentaSubmit);
  document.getElementById('vCantidad').addEventListener('input', recalcVentaPrecioUnitario);
  document.getElementById('vPrecioTotal').addEventListener('input', ()=>{
    recalcVentaPrecioUnitario();
    if(document.getElementById('vMetodoPago').value === 'mixto') syncSplitPago();
  });
  document.querySelectorAll('[data-payment-method]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('[data-payment-method]').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('vMetodoPago').value = btn.dataset.paymentMethod;
      const qrTab = document.querySelector('[data-payment-method="qr"]');
      const splitBox = document.getElementById('vSplitPago');
      if(btn.dataset.paymentMethod === 'qr'){
        openQrPersonaPicker(); // siempre abre el recuadro, aun con "QR de ABNER"
        if(splitBox) splitBox.style.display = 'none';
      }else if(btn.dataset.paymentMethod === 'mixto'){
        if(splitBox) splitBox.style.display = '';
        syncSplitPago();
        openQrPersonaPicker(); // el QR también necesita saber de quién es
      }else{
        if(qrTab) qrTab.textContent = '📱 QR';
        if(splitBox) splitBox.style.display = 'none';
      }
    });
  });
  // Reparto del pago mixto: al escribir uno de los dos montos, el otro se
  // rellena solo con el total menos lo escrito.
  const splitEf = document.getElementById('vEfectivoMonto');
  const splitQr = document.getElementById('vQrMonto');
  if(splitEf) splitEf.addEventListener('input', ()=>{
    const total = parseFloat(document.getElementById('vPrecioTotal').value) || 0;
    const ef = parseFloat(splitEf.value) || 0;
    splitQr.value = Math.max(0, total - ef).toFixed(2);
  });
  if(splitQr) splitQr.addEventListener('input', ()=>{
    const total = parseFloat(document.getElementById('vPrecioTotal').value) || 0;
    const qr = parseFloat(splitQr.value) || 0;
    splitEf.value = Math.max(0, total - qr).toFixed(2);
  });
  const qrSel = document.getElementById('vQrPersona');
  if(qrSel) qrSel.innerHTML = QR_PERSONAS.map(p=>`<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
  const qrOpts = document.getElementById('qrPersonaOptions');
  if(qrOpts){
    qrOpts.addEventListener('click', (e)=>{
      const btn = e.target.closest('[data-qr-persona]');
      if(!btn) return;
      document.getElementById('vQrPersona').value = btn.dataset.qrPersona;
      updateQrTabLabel(document.querySelector('[data-payment-method="qr"]'));
      closeModalById('modalQrPersona');
    });
  }
  document.querySelector('#ventasTable tbody').addEventListener('click', (e)=>{
    const editId = e.target.closest('[data-edit-venta]')?.dataset.editVenta;
    if(editId){
      openVentaEditModal(editId);
      return;
    }
    const delId = e.target.closest('[data-delete-venta]')?.dataset.deleteVenta;
    if(!delId) return;
    const v = db.ventas.find(x => x.id === delId);
    const nombre = v ? (v.nombre || v.codigo) : 'esta venta';
    ventaBorrarDialog('Eliminar venta', `¿Eliminar "${nombre}"?\n\n¿Mantener el inventario?\n• Sí = el inventario NO se modifica.\n• No = la cantidad vuelve al stock.`,
      ()=> deleteVenta(delId, true),
      ()=> deleteVenta(delId, false));
  });

  // Compras
  document.getElementById('btnNuevaCompra').addEventListener('click', openNuevaCompraModal);
  document.getElementById('btnCompraScan').addEventListener('click', ()=>{
    closeAllModals();
    openCompraScan();
  });
  document.getElementById('compraSearchInput').addEventListener('input', renderCompraSearchResults);
  document.getElementById('compraSearchResults').addEventListener('click', (e)=>{
    const id = e.target.closest('[data-compra-select]')?.dataset.compraSelect;
    if(!id) return;
    const p = getProductoById(id);
    closeAllModals();
    if(p) openCompraDetalleForm(p, p.codigo);
  });
  document.getElementById('btnCloseCompraScan').addEventListener('click', closeCompraScan);
  document.getElementById('btnExportCompras').addEventListener('click', exportComprasCSV);
  document.getElementById('btnImportCompras').addEventListener('click', ()=> document.getElementById('fileImportCompras').click());
  document.getElementById('fileImportCompras').addEventListener('change', (e)=>{
    if(e.target.files[0]) importComprasCSV(e.target.files[0]);
    e.target.value = '';
  });
  document.getElementById('btnPurgeCompras').addEventListener('click', ()=>{
    confirmDialog('Borrar ingresos antiguos', '¿Borrar los ingresos de hace más de 3 meses? Se recomienda exportarlos antes con "Exportar CSV". El stock de los productos no se modifica.', ()=>{
      purgeComprasAntiguas();
    });
  });
  document.getElementById('btnVaciarCompras').addEventListener('click', vaciarHistorialCompras);
  document.getElementById('comprasDates').addEventListener('click', (e)=>{
    const chip = e.target.closest('.compra-date-chip');
    if(!chip) return;
    compraDateFilter = chip.dataset.compraDate;
    renderCompras();
  });
  document.getElementById('compraDateInput').addEventListener('change', (e)=>{
    compraDateFilter = e.target.value || 'todas';
    renderCompras();
  });
  document.getElementById('compraSearch').addEventListener('input', (e)=>{
    compraSearch = e.target.value;
    renderCompras();
  });
  document.getElementById('exportCompraReminder').addEventListener('click', (e)=>{
    if(e.target.id === 'btnCompraExportNow'){
      exportComprasCSV();
      markCompraExportPrompt();
      maybeShowCompraReminder();
    }else if(e.target.id === 'btnCompraDismiss'){
      markCompraExportPrompt();
      maybeShowCompraReminder();
    }
  });
  document.getElementById('formCompra').addEventListener('submit', handleCompraSubmit);
  document.getElementById('cCantidad').addEventListener('input', recalcCompraTotal);
  document.getElementById('cPrecioCompra').addEventListener('input', recalcCompraTotal);
  document.getElementById('cActualizarDatos').addEventListener('change', (e)=>{
    document.getElementById('compraUpdateFields').style.display = e.target.checked ? 'grid' : 'none';
  });
  document.querySelectorAll('[data-compra-payment]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('[data-compra-payment]').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('cMetodoPago').value = btn.dataset.compraPayment;
    });
  });
  // Lista de productos en la pestaña Ingresos: al hacer clic se abre el historial.
  document.querySelector('#comprasTable tbody').addEventListener('click', (e)=>{
    const cod = e.target.closest('[data-view-compra-history]')?.dataset.viewCompraHistory;
    const row = e.target.closest('tr[data-compra-prod]');
    if(cod) openCompraHistorial(cod);
    else if(row) openCompraHistorial(row.dataset.compraProd);
  });
  // Historial de ingresos del producto: botón para eliminar un ingreso.
  document.querySelector('#histComprasTable tbody').addEventListener('click', (e)=>{
    const delId = e.target.closest('[data-delete-compra]')?.dataset.deleteCompra;
    if(!delId) return;
    const c = db.compras.find(x => x.id === delId);
    const nombre = c ? (c.nombre || c.codigo) : 'este ingreso';
    ventaBorrarDialog('Eliminar ingreso', `¿Eliminar "${nombre}"?\n\n¿Mantener el inventario?\n• Sí = el inventario NO se modifica.\n• No = la cantidad comprada se quita del stock.`,
      ()=> deleteCompra(delId, true),
      ()=> deleteCompra(delId, false));
  });

  // Estado Financiero / Retiros / Deudas
  document.getElementById('btnEditarCaja').addEventListener('click', openEditarCajaModal);
  document.getElementById('formEditarCaja').addEventListener('submit', handleEditarCajaSubmit);
  document.getElementById('btnExportFinanzas').addEventListener('click', exportFinanzasCSV);
  document.getElementById('btnNuevoRetiro').addEventListener('click', ()=> openRetiroModal());
  document.getElementById('btnExportRetiros').addEventListener('click', exportRetirosCSV);
  document.getElementById('formRetiro').addEventListener('submit', handleRetiroSubmit);
  document.querySelector('#retirosTable tbody').addEventListener('click', (e)=>{
    const editId = e.target.closest('[data-edit-retiro]')?.dataset.editRetiro;
    const delId = e.target.closest('[data-delete-retiro]')?.dataset.deleteRetiro;
    if(editId){
      const r = (db.finanzas.retiros || []).find(x => x.id === editId);
      if(r) openRetiroModal(r);
    }
    if(delId) deleteRetiro(delId);
  });
  document.getElementById('btnNuevaDeuda').addEventListener('click', ()=> openDeudaModal());
  document.getElementById('btnExportDeudas').addEventListener('click', exportDeudasCSV);
  document.getElementById('formDeuda').addEventListener('submit', handleDeudaSubmit);
  document.getElementById('deudasGroups').addEventListener('click', (e)=>{
    const editId = e.target.closest('[data-edit-deuda]')?.dataset.editDeuda;
    const delId = e.target.closest('[data-delete-deuda]')?.dataset.deleteDeuda;
    if(editId){
      const d = (db.finanzas.deudas || []).find(x => x.id === editId);
      if(d) openDeudaModal(d);
    }
    if(delId) deleteDeuda(delId);
  });
  document.getElementById('retirosMes').addEventListener('change', (e)=>{
    retiroMesFilter = e.target.value;
    renderRetiros();
  });
  document.getElementById('deudasMes').addEventListener('change', (e)=>{
    deudaMesFilter = e.target.value;
    renderDeudas();
  });
  document.getElementById('rMarca').addEventListener('change', (e)=>{
    syncNuevaMarcaRow(e.target, document.getElementById('rNuevaMarca'), document.getElementById('rNuevaMarcaRow'));
  });
  document.getElementById('dMarca').addEventListener('change', (e)=>{
    syncNuevaMarcaRow(e.target, document.getElementById('dNuevaMarca'), document.getElementById('dNuevaMarcaRow'));
  });

  // Gastos del día
  document.getElementById('btnNuevoGasto').addEventListener('click', ()=> openGastoModal());
  document.getElementById('formGasto').addEventListener('submit', handleGastoSubmit);
  document.getElementById('gCant').addEventListener('input', recalcGastoTotal);
  document.getElementById('gBs').addEventListener('input', recalcGastoTotal);
  document.querySelector('#gastosTable tbody').addEventListener('click', (e)=>{
    const editId = e.target.closest('[data-edit-gasto]')?.dataset.editGasto;
    const delId = e.target.closest('[data-delete-gasto]')?.dataset.deleteGasto;
    if(editId){
      const g = (db.gastos || []).find(x => x.id === editId);
      if(g) openGastoModal(g);
    }
    if(delId) deleteGasto(delId);
  });

  // Productos más vendidos (filtro por mes + stock mínimo editable + import/export)
  document.getElementById('topVentasMes').addEventListener('change', (e)=>{
    topVentasMesFilter = e.target.value;
    renderTopVentas();
  });
  document.getElementById('btnExportTopVentas').addEventListener('click', exportTopVentasCSV);
  document.getElementById('btnImportTopVentas').addEventListener('click', ()=> document.getElementById('fileImportTopVentas').click());
  document.getElementById('fileImportTopVentas').addEventListener('change', (e)=>{
    if(e.target.files[0]) importTopVentasCSV(e.target.files[0]);
    e.target.value = '';
  });
  document.querySelector('#topVentasTable tbody').addEventListener('change', (e)=>{
    if(!e.target.classList.contains('stock-min-input')) return;
    const val = parseInt(e.target.value, 10);
    const p = getProductoByCodigo(e.target.dataset.codigo);
    if(!p) return;
    p.stockMin = isNaN(val) || val < 0 ? 0 : val;
    saveDB();
    renderTopVentas();
    renderProductos();
    toast('Stock mínimo actualizado', 'success');
  });

  // Pedidos (reposición por stock / marca)
  document.getElementById('pedidoMarcaFilter').addEventListener('change', renderPedidos);
  document.getElementById('btnExportPedidos').addEventListener('click', exportPedidosCSV);
  document.getElementById('btnImportPedidos').addEventListener('click', ()=> document.getElementById('fileImportPedidos').click());
  document.getElementById('fileImportPedidos').addEventListener('change', (e)=>{
    if(e.target.files[0]) importPedidosCSV(e.target.files[0]);
    e.target.value = '';
  });
  document.querySelector('#pedidosTable tbody').addEventListener('change', (e)=>{
    if(e.target.classList.contains('pedido-stockmin-input')){
      const val = parseInt(e.target.value, 10);
      const p = getProductoByCodigo(e.target.dataset.codigo);
      if(!p) return;
      p.stockMin = isNaN(val) || val < 0 ? 0 : val;
      saveDB();
      syncProductoDoc(p); // el stock mínimo también se comparte en la nube
      renderPedidos();
      toast('Stock mínimo actualizado', 'success');
    }else if(e.target.classList.contains('pedido-cant-input')){
      const val = parseInt(e.target.value, 10);
      pedidoCantidades[normalize(e.target.dataset.codigo)] = isNaN(val) || val < 0 ? 0 : val;
      updatePedidoSummary();
    }
  });

  // Inventario
  document.getElementById('invSearch').addEventListener('input', renderInventario);
  document.getElementById('btnRegistroInventario').addEventListener('click', openInventarioScan);
  document.getElementById('btnCloseInventarioScan').addEventListener('click', closeInventarioScan);
  document.getElementById('btnExportInventario').addEventListener('click', exportInventarioCSV);
  document.getElementById('btnImportInventario').addEventListener('click', ()=> document.getElementById('fileImportInventario').click());
  document.getElementById('fileImportInventario').addEventListener('change', (e)=>{
    if(e.target.files[0]) importInventarioCSV(e.target.files[0]);
    e.target.value = '';
  });
  document.getElementById('formInventario').addEventListener('submit', handleInventarioSubmit);
  document.querySelectorAll('.inv-qty-btn').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      registrarInventarioCantidad(parseInt(btn.dataset.invQty, 10));
    });
  });
  document.getElementById('btnInvMas').addEventListener('click', ()=>{
    const masBox = document.getElementById('invMasBox');
    if(masBox){
      masBox.style.display = 'block';
      document.getElementById('invCantidad').focus();
    }
  });
  document.querySelector('#inventarioTable tbody').addEventListener('click', (e)=>{
    const editId = e.target.closest('[data-edit-inventario]')?.dataset.editInventario;
    if(editId){
      const p = getProductoById(editId);
      if(p) openEditarInventarioModal(p);
    }
  });
  document.getElementById('formEditarInventario').addEventListener('submit', handleEditarInventarioSubmit);

  // Historial
  document.getElementById('btnClearScanHistory').addEventListener('click', ()=>{
    confirmDialog('Borrar historial de escaneos', '¿Seguro que quieres borrar todo el historial de códigos escaneados?', ()=>{
      db.historialEscaneos = [];
      saveDB();
      renderHistorial();
      toast('Historial de escaneos borrado', 'success');
    });
  });
  document.getElementById('btnClearInventarioHistory').addEventListener('click', ()=>{
    confirmDialog('Borrar historial de inventario', '¿Seguro que quieres borrar todo el historial de registros de inventario?', ()=>{
      db.historialInventario = [];
      saveDB();
      renderHistorial();
      toast('Historial de inventario borrado', 'success');
    });
  });
  document.getElementById('btnClearSearchHistory').addEventListener('click', ()=>{
    confirmDialog('Borrar historial de búsquedas', '¿Seguro que quieres borrar todo el historial de búsquedas?', ()=>{
      db.historialBusquedas = [];
      saveDB();
      renderHistorial();
      toast('Historial de búsquedas borrado', 'success');
    });
  });

  // Importaciones CSV (desde Productos y desde Configuración)
  document.getElementById('btnImportProducts').addEventListener('click', ()=> document.getElementById('fileImportProducts').click());
  document.getElementById('btnImportProductsConfig').addEventListener('click', ()=> document.getElementById('fileImportProducts').click());
  document.getElementById('fileImportProducts').addEventListener('change', (e)=>{
    if(e.target.files[0]) importProductsCSV(e.target.files[0]);
    e.target.value = '';
  });

  // Backup / Configuración
  document.getElementById('btnExportBackup').addEventListener('click', exportBackup);
  document.getElementById('btnImportBackup').addEventListener('click', ()=> document.getElementById('fileImportBackup').click());
  document.getElementById('fileImportBackup').addEventListener('change', (e)=>{
    if(e.target.files[0]) importBackup(e.target.files[0]);
    e.target.value = '';
  });
  document.getElementById('btnFactoryReset').addEventListener('click', factoryReset);
}

function init(){
  restoreModo(); // decide qué modo/rol estaba activo ANTES de cargar datos
  loadDB();
  loadInvUpdates();
  loadImagesForModo(currentModo).then(()=> rerenderCurrentView()); // imágenes locales de este dispositivo
  migrateLegacyPasswords(); // sube contraseñas viejas para sincronizarlas
  setupEventListeners();
  syncRememberSwitchUI();
  syncNotifSwitchUI();
  syncProModeUI();
  updateSidebarProductCount();
  updateSidebarBrand();
  updatePasswordButtonLabel();
  // Si en este dispositivo se dejó la sesión abierta para el modo guardado,
  // vuelve directo a la app sin pedir contraseña ni pasar por Inicio.
  let savedMode = null;
  try{ savedMode = localStorage.getItem(MODO_KEY); }catch(e){}
  if(savedMode && savedMode !== 'invitado' && isRemembered(savedMode)){
    switchModoData(savedMode); // ya conecta Firebase para ese modo
    applyRoleUI();
    showView('escaner');
  }else{
    showView('inicio');
    connectFirebase(); // no bloquea el arranque; si no está configurado, sigue todo local
  }
  updateInicioClock();
  setInterval(updateInicioClock, 1000);
  // Precalienta Tesseract unos segundos después de cargar: así el primer
  // escaneo no espera la descarga del idioma ni el arranque del motor.
  setTimeout(()=>{ warmupOcrWorker(); }, 3500);
}

document.addEventListener('DOMContentLoaded', init);
