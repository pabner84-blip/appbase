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
  invUpdates[productoId] = todayISO();
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
    ventas: []
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
  obj.productos.forEach(p=>{
    p.codigoBarras = p.codigoBarras || '';
    p.stock = typeof p.stock === 'number' ? p.stock : 0;
  });
  return obj;
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
function saveDB(){
  if(currentModo === 'invitado') return; // el invitado no escribe sobre las bases de cada modo
  persistLocalCache();
  if(fbReady && fbDocRef){
    const { historialEscaneos, historialBusquedas, historialInventario, ...syncData } = db;
    fbDocRef.set(syncData).then(()=>{
      setSyncStatus('synced');
    }).catch(err=>{
      console.error('Error guardando en Firebase', err);
      setSyncStatus('error');
    });
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
  merged.ventas = m.ventas.concat(e.ventas).sort((a,b)=> new Date(b.fecha) - new Date(a.fecha));
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
      ref.set(syncData).then(()=>{
        setSyncStatus('synced');
      }).catch(err=>{
        console.error('Error guardando en Firebase', err);
        setSyncStatus('error');
      });
    }catch(err){
      console.error('Error guardando en Firebase', err);
    }
  }
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
    ['manual','electrico'].forEach(modo => {
      const ref = fbFirestore.collection('stockferre').doc('inventario_' + modo);
      ref.get().then(snap=>{
        if(snap.exists){
          const prev = loadModoDB(modo);
          const remote = normalizeDB(snap.data());
          remote.historialEscaneos = prev.historialEscaneos;
          remote.historialBusquedas = prev.historialBusquedas;
          remote.historialInventario = prev.historialInventario;
          try{ localStorage.setItem('stockferre_catalogo_v1_' + modo, JSON.stringify(remote)); }catch(e){}
          if(currentModo === 'invitado'){ db = buildGuestDB(); rerenderCurrentView(); }
        }
      }).catch(()=>{ /* local sigue funcionando */ });
      const unsub = ref.onSnapshot(snap=>{
        if(snap.metadata.hasPendingWrites) return;
        if(!snap.exists) return;
        const prev = loadModoDB(modo);
        const remote = normalizeDB(snap.data());
        remote.historialEscaneos = prev.historialEscaneos;
        remote.historialBusquedas = prev.historialBusquedas;
        remote.historialInventario = prev.historialInventario;
        try{ localStorage.setItem('stockferre_catalogo_v1_' + modo, JSON.stringify(remote)); }catch(e){}
        if(currentModo === 'invitado'){ db = buildGuestDB(); rerenderCurrentView(); }
      }, ()=>{ /* ignorar */ });
      guestUnsubs.push(unsub);
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
    fbDocRef = fbFirestore.collection('stockferre').doc(firebaseDocId());
    fbReady = true;

    const snap = await fbDocRef.get();
    if(snap.exists){
      // Ya hay datos en la nube: son la fuente de verdad, mantenemos el historial local
      const remote = normalizeDB(snap.data());
      remote.historialEscaneos = db.historialEscaneos;
      remote.historialBusquedas = db.historialBusquedas;
      remote.historialInventario = db.historialInventario;
      db = remote;
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
      const remote = normalizeDB(snap.data());
      remote.historialEscaneos = db.historialEscaneos;
      remote.historialBusquedas = db.historialBusquedas;
      remote.historialInventario = db.historialInventario;
      db = remote;
      persistLocalCache();
      rerenderCurrentView();
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
    remote.historialEscaneos = prev.historialEscaneos;
    remote.historialBusquedas = prev.historialBusquedas;
    remote.historialInventario = prev.historialInventario;
    localStorage.setItem('stockferre_catalogo_v1_' + modo, JSON.stringify(remote));
  }catch(e){ /* ignorar */ }
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
    saveDB();
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
      saveDB();
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
      stock: 0,
      fechaCreacion: todayISO()
    };
    db.productos.push(p);
    saveDB();
    return p;
  }
}

function deleteProducto(id){
  confirmDialog('Eliminar producto', '¿Seguro que quieres eliminar este producto? Esta acción no se puede deshacer.', ()=>{
    db.productos = db.productos.filter(p => p.id !== id);
    saveDB();
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
    fecha: todayISO()
  };

  // En modo invitado la venta se guarda en la base del modo al que pertenece
  // el producto (Manuales o Eléctricas), no en una base de invitado.
  if(currentModo === 'invitado'){
    guestCommitVenta(venta, data, cantidad);
    return venta;
  }

  db.ventas.unshift(venta);

  // Descuenta del stock del producto (si es un producto real, no "OTRO").
  // Se permite que el stock quede en 0 o negativo: la venta nunca se bloquea.
  const p = getProductoByCodigo(data.codigo);
  if(p){
    p.stock = (p.stock || 0) - cantidad;
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
  }
  dbObj.contador = dbObj.contador || { producto: 1, venta: 1 };
  dbObj.contador.venta = dbObj.contador.venta || 1;
  const n = dbObj.contador.venta++;
  dbObj.ventas.unshift({ ...venta, id: 'v' + n + '_' + Date.now().toString(36) });
  persistModoDB(modo, dbObj);
  // Reconstruye la vista combinada para que la venta aparezca al instante
  db = buildGuestDB();
  renderVentas();
  renderProductos();
}

function deleteVenta(id){
  confirmDialog('Eliminar venta', '¿Seguro que quieres eliminar este registro de venta? El stock del producto se restaurará.', ()=>{
    const venta = db.ventas.find(v => v.id === id);
    if(venta){
      const p = getProductoByCodigo(venta.codigo);
      if(p) p.stock = (p.stock || 0) + venta.cantidad;
    }
    db.ventas = db.ventas.filter(v => v.id !== id);
    saveDB();
    renderVentas();
    renderInventario();
    renderProductos();
    toast('Venta eliminada', 'success');
  });
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

function openVentaModal(producto){
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
  updateVentaDestinoUI(producto.modoOrigin || 'manual', true);
  recalcVentaPrecioUnitario();
  openModal('modalVenta');
}

// Venta de un producto que NO está en el inventario: se pide una descripción
// libre y un precio. Se registra en el historial de ventas, pero nunca se
// crea como producto ni afecta ningún stock.
function openVentaModalOtro(){
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
  updateVentaDestinoUI('manual', false);
  recalcVentaPrecioUnitario();
  openModal('modalVenta');
  setTimeout(()=> document.getElementById('vNombreOtroInput').focus(), 50);
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
  saveVenta({ codigo, nombre, cantidad, total, metodoPago, modoDestino });
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
// dentro de cualquier contenedor. En la pestaña Inventario es exactamente
// igual, solo que el botón de acción dice "Registrar" y lleva al registro
// de cantidad en vez de abrir la venta.
function renderScanResultInto(elementId, codigo, context){
  const resultDiv = document.getElementById(elementId);
  if(!resultDiv) return;
  const p = getProductoByCodigo(codigo);

  if(!p){
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
        ${currentRole === 'guest' ? '' : `<button class="btn btn-secondary btn-sm" id="btnEditFromScan_${elementId}">✏️ Editar producto</button>`}
        ${secondBtnHtml}
      </div>
    </div>`;

  const btnEdit = document.getElementById(`btnEditFromScan_${elementId}`);
  if(btnEdit) btnEdit.addEventListener('click', ()=>{
    openProductModal(p);
  });
  document.getElementById(`btnActionFromScan_${elementId}`).addEventListener('click', ()=>{
    if(context === 'inventario'){
      closeInventarioScan();
      openInventarioDetalleForm(p, codigo);
    }else{
      openVentaModal(p);
    }
  });
}

// scanContext: 'lookup' (pestaña Escanear normal) o 'inventario' (registro de
// cantidad desde la pestaña Inventario) — cambia qué pasa al detectar un código
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

const PAYMENT_LABELS = { efectivo: '💵 Efectivo', qr: '📱 QR' };

function renderVentas(){
  const tbody = document.querySelector('#ventasTable tbody');
  const summary = document.getElementById('ventasSummary');

  if(db.ventas.length === 0){
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${currentRole === 'guest' ? 7 : 8}">Todavía no registraste ninguna venta.</td></tr>`;
    summary.textContent = '0 ventas';
    return;
  }

  tbody.innerHTML = db.ventas.map(v => `
    <tr>
      <td>${fmtHistoryDate(v.fecha)}</td>
      <td><strong>${escapeHtml(v.codigo)}</strong></td>
      <td>${escapeHtml(v.nombre)}</td>
      <td>${v.cantidad}</td>
      <td>${fmtMoney(v.precioUnitario)}</td>
      <td><strong>${fmtMoney(v.total)}</strong></td>
      <td>${PAYMENT_LABELS[v.metodoPago] || v.metodoPago}</td>
      ${currentRole === 'guest' ? '' : `<td><button class="btn-icon" title="Eliminar" data-delete-venta="${v.id}">🗑️</button></td>`}
    </tr>
  `).join('');

  const totalMonto = db.ventas.reduce((sum, v) => sum + v.total, 0);
  summary.textContent = `${db.ventas.length} venta${db.ventas.length === 1 ? '' : 's'} · ${fmtMoney(totalMonto)} en total`;
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
  list.sort((a,b)=> a.nombre.localeCompare(b.nombre, 'es'));

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
  markInventarioActualizado(p.id);
  logInventarioHistorial(p, stockVal - stockAnterior, 'ajuste manual');
  saveDB();
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

// Al detectar un código en la pestaña de Inventario, el comportamiento es
// idéntico al de la pestaña "Escanear" (misma cámara, mismo resultado debajo):
// la única diferencia es que el botón de acción dice "Registrar" y lleva al
// recuadro de cantidad / código de barras en vez de abrir una venta.
function handleInventoryScan(codigo){
  renderScanResultInto('invScanResultBox', codigo, 'inventario');
}

// Abre el recuadro de "Registrar inventario" ya con la descripción del
// producto lista, pidiendo solo cantidad y código de barras.
function openInventarioDetalleForm(producto, codigo){
  document.getElementById('invCodigo').value = codigo;
  document.getElementById('invNombreDisplay').textContent = producto.nombre;
  document.getElementById('invStockActualDisplay').textContent = `Stock actual: ${producto.stock || 0}`;
  document.getElementById('invCantidad').value = 1;
  document.getElementById('invCodigoBarras').value = producto.codigoBarras || '';
  openModal('modalInventarioDetalle');
}

function handleInventarioSubmit(e){
  e.preventDefault();
  const codigo = document.getElementById('invCodigo').value;
  const cantidad = parseFloat(document.getElementById('invCantidad').value);
  const codigoBarras = document.getElementById('invCodigoBarras').value.trim();

  if(!cantidad || cantidad <= 0){
    toast('Ingresa una cantidad válida', 'error');
    return;
  }
  const p = getProductoByCodigo(codigo);
  if(!p) return;

  p.stock = (p.stock || 0) + cantidad;
  if(codigoBarras) p.codigoBarras = codigoBarras;
  markInventarioActualizado(p.id);
  logInventarioHistorial(p, cantidad, 'registro (escáner)');
  saveDB();
  renderInventario();
  renderProductos();
  closeAllModals();
  toast(`Stock actualizado: ${p.nombre} → ${p.stock}`, 'success');

  // Sigue escaneando el siguiente producto sin que el usuario tenga que
  // volver a tocar el botón (pensado para hacer un conteo físico seguido)
  openInventarioScan();
}

/* -------------------------------------------------------------------------
   4d. NUEVA VENTA (buscar producto existente o vender algo "OTRO")
   ------------------------------------------------------------------------- */

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

const csvEscapeField = v => {
  v = String(v ?? '');
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g,'""') + '"' : v;
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
  const csv = [header, ...rows].map(r => r.map(csvEscapeField).join(',')).join('\n');
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

function exportProductosCSV(){
  if(db.productos.length === 0){
    toast('No hay productos para exportar', 'error');
    return;
  }
  const header = ['CODIGO','CODIGO DE BARRAS','DESCRIPCION','MARCA','CATEGORIA','PRECIO COMPRA','PRECIO MARCA','PRECIO VENTA','STOCK'];
  const rows = db.productos.map(p => [
    p.codigo, p.codigoBarras||'', p.nombre, p.marca||'', p.categoria||'',
    csvNumber(p.precioCompra, 2), csvNumber(p.precioMarca, 2), csvNumber(p.precioVenta, 2), csvNumber(p.stock)
  ]);
  downloadCSV(`stockferre_productos_${todayISO().slice(0,10)}.csv`, header, rows);
  toast('Productos exportados', 'success');
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
        markInventarioActualizado(p.id);
        logInventarioHistorial(p, p.stock - stockAnterior, 'importación CSV');
        actualizados++;
      }
      saveDB();
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
  const header = ['FECHA','CODIGO','PRODUCTO','CANTIDAD','PRECIO UNITARIO','TOTAL','METODO DE PAGO'];
  const rows = db.ventas.map(v => [
    v.fecha, v.codigo, v.nombre, csvNumber(v.cantidad), csvNumber(v.precioUnitario, 2), csvNumber(v.total, 2), v.metodoPago
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
        metodoPago: headers.findIndex(h => h.includes('PAGO'))
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
        db.ventas.push({
          id: uid('venta'),
          codigo: String(r[idx.codigo] || '').trim() || 'OTRO',
          nombre,
          cantidad,
          precioUnitario,
          total,
          metodoPago: idx.metodoPago > -1 ? (String(r[idx.metodoPago]||'').toLowerCase().includes('qr') ? 'qr' : 'efectivo') : 'efectivo',
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
    p.codigo, p.nombre, p.marca||'', p.categoria||'', p.codigoBarras||'', csvNumber(p.stock)
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
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${currentRole === 'guest' ? 8 : 9}">No hay productos que coincidan.</td></tr>`;
  }else{
    tbody.innerHTML = list.map(p => `
      <tr>
        <td><strong>${escapeHtml(p.codigo)}</strong></td>
        <td>${escapeHtml(p.codigoBarras || '-')}</td>
        <td>${escapeHtml(p.nombre)}</td>
        <td>${escapeHtml(p.marca || '-')}</td>
        <td>${p.categoria ? `<span class="badge badge-muted">${escapeHtml(p.categoria)}</span>` : '-'}</td>
        <td class="price-guest-hide">${fmtMoney(p.precioCompra)}</td>
        <td class="price-guest-hide">${fmtMoney(p.precioMarca)}</td>
        <td>${fmtMoney(p.precioVenta)}</td>
        ${currentRole === 'guest' ? '' : `
        <td>
          <button class="btn-icon" title="Editar" data-edit-product="${p.id}">✏️</button>
          <button class="btn-icon" title="Eliminar" data-delete-product="${p.id}">🗑️</button>
        </td>`}
      </tr>
    `).join('');
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
      else if(ch === delimiter){ row.push(field); field = ''; }
      else if(ch === '\n'){ row.push(field); rows.push(row); row = []; field = ''; }
      else{ field += ch; }
    }
  }
  if(field.length || row.length){ row.push(field); rows.push(row); }
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
      const rows = parseCSV(e.target.result);
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
        precioVenta: headers.findIndex(h => h.includes('PRECIO') && h.includes('VENTA'))
      };
      if(idx.codigo === -1 || idx.nombre === -1){
        toast('El CSV debe tener al menos columnas CODIGO y DESCRIPCION', 'error');
        return;
      }
      if(idx.precioCompra === -1 || idx.precioVenta === -1){
        toast('No se encontraron las columnas de precio (se importarán los productos, pero revisa los precios manualmente)', 'warning');
      }

      let creados = 0, actualizados = 0;
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

        if(categoria) upsertCategoria(categoria);

        const existing = getProductoByCodigo(codigo);
        if(existing){
          existing.nombre = nombre || existing.nombre;
          existing.marca = marca || existing.marca;
          existing.categoria = categoria || existing.categoria;
          existing.codigoBarras = codigoBarras || existing.codigoBarras;
          existing.precioCompra = precioCompra || existing.precioCompra;
          existing.precioMarca = precioMarca || existing.precioMarca;
          existing.precioVenta = precioVenta || existing.precioVenta;
          actualizados++;
        }else{
          db.productos.push({
            id: uid(),
            codigo, codigoBarras, nombre, marca, categoria,
            precioCompra, precioMarca, precioVenta,
            stock: 0,
            fechaCreacion: todayISO()
          });
          creados++;
        }
      }
      saveDB();
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
  const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
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
  if(currentRole === 'guest' && (name === 'inventario' || name === 'config')){
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
  closeSidebarMobile();
  closeAllModals(); // por si venías con el escáner de inventario u otro modal abierto
  restoreScannerBlockHome();
  scanContext = 'lookup';

  if(name === 'inicio') updateInicioClock();
  if(name === 'productos') renderProductos();
  if(name === 'categorias') renderCategorias();
  if(name === 'ventas') renderVentas();
  if(name === 'inventario') renderInventario();
  if(name === 'historial') renderHistorial();
  if(name === 'escaner'){
    document.getElementById('scanResult').innerHTML = '';
    if(!ocrActive && !zxingLiveActive) startActiveScanner();
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
const MODO_LABELS = { manual: 'Herramientas Manuales', electrico: 'Herramientas Eléctricas', invitado: 'Modo Invitado' };

let pendingGateModo = null;

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
  if(modo === 'invitado') connectGuestFirebase();
  else connectFirebase();
}

// Punto de entrada desde los botones de Inicio (🔧 Manuales / ⚡ Eléctricas).
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
// color de ese modo (rojo/azul/verde). Conserva el menú lateral para navegar.
function showWelcomeForMode(modo){
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-welcome').classList.add('active');
  document.getElementById('welcomeTitle').textContent = 'BIENVENIDO';
  const sub = modo === 'manual' ? 'Herramientas Manuales'
    : modo === 'electrico' ? 'Herramientas Eléctricas'
    : 'TIENDA 1';
  document.getElementById('welcomeSubtitle').textContent = sub;
  document.querySelectorAll('.nav-item[data-view]').forEach(btn=> btn.classList.remove('active'));
  document.getElementById('viewTitle').textContent = sub;
  document.body.classList.remove('inicio-theme');
  closeSidebarMobile();
  closeAllModals();
  restoreScannerBlockHome();
  scanContext = 'lookup';
  // Voz de asistente al entrar a las pantallas de bienvenida
  setTimeout(()=> speak('Bienvenido, ' + sub), 350);
}

// Voz de asistente (mujer en español si está disponible) usando la API de
// síntesis de voz del navegador.
function speak(text){
  if(!('speechSynthesis' in window)) return;
  try{
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'es-ES';
    u.rate = 0.95;
    u.pitch = 1.05;
    const pick = ()=>{
      const voices = window.speechSynthesis.getVoices();
      const es = voices.filter(v => (v.lang||'').toLowerCase().indexOf('es') === 0);
      if(es.length){
        const fem = es.find(v => /sabina|monica|paul|helena|laura|marcela|google/i.test(v.name)) || es.find(v => /female|femenina/i.test(v.name)) || es[0];
        u.voice = fem;
      }
      window.speechSynthesis.speak(u);
    };
    if(window.speechSynthesis.getVoices().length) pick();
    else{
      window.speechSynthesis.onvoiceschanged = ()=>{ window.speechSynthesis.onvoiceschanged = null; pick(); };
      setTimeout(pick, 300);
    }
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
  const strongEl = document.querySelector('.sidebar-brand .brand-text strong');
  const smallEl = document.querySelector('.sidebar-brand .brand-text small');
  if(strongEl) strongEl.textContent = MODO_LABELS[currentModo] || 'TIENDA 1';
  if(smallEl) smallEl.textContent = currentRole === 'guest' ? '👤 Modo invitado' : 'Consulta de productos';
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
  document.querySelectorAll('.modal.open').forEach(m => m.classList.remove('open'));
  document.getElementById('modalBackdrop').classList.remove('open');
  if(inventarioScanWasOpen){
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

const OCR_INTERVAL_MS = 600;

let ocrWorker = null;
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
    ocrWorker = await Tesseract.createWorker('eng');
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

    // Escala x2 el recorte: los códigos son pequeños en la imagen original
    // y una imagen más grande mejora mucho la precisión del OCR.
    const scale = 2;
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

  // Sidebar móvil
  document.getElementById('hamburgerBtn').addEventListener('click', ()=>{
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebarOverlay').classList.add('open');
  });
  document.getElementById('sidebarOverlay').addEventListener('click', closeSidebarMobile);

  // Botones de Inicio: Herramientas Manuales (rojo) / Herramientas Eléctricas (azul) / Invitado (verde)
  document.getElementById('btnModoManual').addEventListener('click', ()=> attemptEnterModo('manual'));
  document.getElementById('btnModoElectrico').addEventListener('click', ()=> attemptEnterModo('electrico'));
  document.getElementById('btnModoInvitado').addEventListener('click', ()=> enterModoAsGuest());

  // Botón "Volver al Inicio" del menú lateral: regresa a la pantalla principal
  document.getElementById('btnVolverInicio').addEventListener('click', ()=>{
    stopActiveScanner();
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
  document.getElementById('btnExportProducts').addEventListener('click', exportProductosCSV);
  document.getElementById('formProducto').addEventListener('submit', handleProductSubmit);
  document.getElementById('prodSearch').addEventListener('input', renderProductos);
  document.getElementById('prodSearch').addEventListener('change', (e)=>{
    logSearchHistory(e.target.value);
  });
  document.getElementById('prodFilterCategoria').addEventListener('change', renderProductos);
  document.querySelector('#productsTable tbody').addEventListener('click', (e)=>{
    const editId = e.target.closest('[data-edit-product]')?.dataset.editProduct;
    const delId = e.target.closest('[data-delete-product]')?.dataset.deleteProduct;
    if(editId) openProductModal(getProductoById(editId));
    if(delId) deleteProducto(delId);
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
  document.getElementById('btnExportVentas').addEventListener('click', exportVentasCSV);
  document.getElementById('btnImportVentas').addEventListener('click', ()=> document.getElementById('fileImportVentas').click());
  document.getElementById('fileImportVentas').addEventListener('change', (e)=>{
    if(e.target.files[0]) importVentasCSV(e.target.files[0]);
    e.target.value = '';
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
  document.getElementById('vPrecioTotal').addEventListener('input', recalcVentaPrecioUnitario);
  document.querySelectorAll('[data-payment-method]').forEach(btn=>{
    btn.addEventListener('click', ()=>{
      document.querySelectorAll('[data-payment-method]').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('vMetodoPago').value = btn.dataset.paymentMethod;
    });
  });
  document.querySelector('#ventasTable tbody').addEventListener('click', (e)=>{
    const delId = e.target.closest('[data-delete-venta]')?.dataset.deleteVenta;
    if(delId) deleteVenta(delId);
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
  document.querySelector('#inventarioTable tbody').addEventListener('click', (e)=>{
    const editId = e.target.closest('[data-edit-inventario]')?.dataset.editInventario;
    if(editId){
      const p = getProductoById(editId);
      if(p) openEditarInventarioModal(p);
    }
  });
  document.getElementById('formEditarInventario').addEventListener('submit', handleEditarInventarioSubmit);
  document.getElementById('btnScanBarcode').addEventListener('click', openBarcodeScanModal);

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
  migrateLegacyPasswords(); // sube contraseñas viejas para sincronizarlas
  setupEventListeners();
  showView('inicio');
  updateInicioClock();
  setInterval(updateInicioClock, 1000);
  updateSidebarProductCount();
  updateSidebarBrand();
  updatePasswordButtonLabel();
  connectFirebase(); // no bloquea el arranque; si no está configurado, sigue todo local
}

document.addEventListener('DOMContentLoaded', init);
