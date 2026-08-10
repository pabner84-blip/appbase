// ============================================================
// FERRETERÍA · App de inventario — Firebase + Escáner OCR + Inventario
// Incluye: login, Firestore, escáner OCR (Tesseract), pestaña Inventario,
// campo código de barras, exportar/importar CSV, categorías e historial.
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, where, getDoc, serverTimestamp, increment, Timestamp, writeBatch, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---- Tu configuración de Firebase ----
const firebaseConfig = {
  apiKey: "AIzaSyBzl4dJy3ofDNkFV2WNy3If2crpZZScqsk",
  authDomain: "app-ferreteria-bd73f.firebaseapp.com",
  projectId: "app-ferreteria-bd73f",
  storageBucket: "app-ferreteria-bd73f.firebasestorage.app",
  messagingSenderId: "358852202919",
  appId: "1:358852202919:web:8f2a3fc62be0ca1d232682"
};

// Correo que se registra automáticamente como ADMIN la primera vez que entra
const ADMIN_BOOTSTRAP_EMAIL = "abnerdaniloperezquispe@gmail.com";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ---------------- Elementos DOM ----------------
const loginScreen = document.getElementById("login-screen");
const appShell = document.getElementById("app-shell");
const loginForm = document.getElementById("login-form");
const loginEmail = document.getElementById("login-email");
const loginPass = document.getElementById("login-pass");
const loginBtn = document.getElementById("login-btn");
const loginError = document.getElementById("login-error");
const whoEmail = document.getElementById("who-email");
const whoRole = document.getElementById("who-role");
const logoutBtn = document.getElementById("logout-btn");
const toastEl = document.getElementById("toast");

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  setTimeout(() => toastEl.classList.remove("show"), 2600);
}

// ---------------- LOGIN ----------------
loginForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.style.display = "none";
  loginBtn.disabled = true;
  loginBtn.textContent = "Ingresando...";
  try {
    await signInWithEmailAndPassword(auth, loginEmail.value.trim(), loginPass.value);
  } catch (err) {
    loginError.textContent = traducirErrorAuth(err.code);
    loginError.style.display = "block";
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = "Ingresar";
  }
});

function traducirErrorAuth(code) {
  const map = {
    "auth/invalid-credential": "Correo o contraseña incorrectos.",
    "auth/invalid-email": "El correo no es válido.",
    "auth/user-not-found": "No existe una cuenta con ese correo.",
    "auth/wrong-password": "Contraseña incorrecta.",
    "auth/too-many-requests": "Demasiados intentos. Espera un momento e intenta de nuevo."
  };
  return map[code] || "No se pudo iniciar sesión. Intenta de nuevo.";
}

logoutBtn.addEventListener("click", () => signOut(auth));

// ---------------- Sesión / bootstrap de rol ----------------
let currentUser = null;
let currentRole = "vendedor";
let unsubProducts = null;
let unsubCompras = null;
let unsubTurno = null;
let unsubMovimientos = null;
let unsubVentas = null;
let unsubGastos = null;
let unsubCategorias = null;
let unsubHistorial = null;
let unsubHistorialBusquedas = null;

onAuthStateChanged(auth, async (user) => {
  if (user) {
    currentUser = user;
    await ensureUserDoc(user);
    loginScreen.style.display = "none";
    appShell.classList.add("active");
    startProductsListener();
    startComprasListener();
    startTurnoListener();
    startVentasListener();
    startGastosListener();
    startCategoriasListener();
    startHistorialListeners();
  } else {
    currentUser = null;
    appShell.classList.remove("active");
    loginScreen.style.display = "flex";
    if (unsubProducts) { unsubProducts(); unsubProducts = null; }
    if (unsubCompras) { unsubCompras(); unsubCompras = null; }
    if (unsubTurno) { unsubTurno(); unsubTurno = null; }
    if (unsubMovimientos) { unsubMovimientos(); unsubMovimientos = null; }
    if (unsubVentas) { unsubVentas(); unsubVentas = null; }
    if (unsubGastos) { unsubGastos(); unsubGastos = null; }
    if (unsubCategorias) { unsubCategorias(); unsubCategorias = null; }
    if (unsubHistorial) { unsubHistorial(); unsubHistorial = null; }
    if (unsubHistorialBusquedas) { unsubHistorialBusquedas(); unsubHistorialBusquedas = null; }
    allScans = [];
    allBuscados = [];
    allCategorias = [];
  }
});

// Crea el documento del usuario en /usuarios/{uid} si no existe.
// El correo definido en ADMIN_BOOTSTRAP_EMAIL se vuelve admin automáticamente la primera vez.
async function ensureUserDoc(user) {
  const ref = doc(db, "usuarios", user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    const rol = user.email.toLowerCase() === ADMIN_BOOTSTRAP_EMAIL.toLowerCase() ? "admin" : "vendedor";
    await setDoc(ref, {
      email: user.email,
      rol,
      creadoEn: serverTimestamp()
    });
    currentRole = rol;
  } else {
    currentRole = snap.data().rol || "vendedor";
  }
  whoEmail.textContent = user.email;
  whoRole.textContent = currentRole;
}

// ---------------- Navegación ----------------
const navItems = document.querySelectorAll(".nav-item");

function switchView(viewName) {
  const target = document.querySelector(`.nav-item[data-view="${viewName}"]`);
  if (!target || target.classList.contains("disabled")) return;
  navItems.forEach(n => n.classList.remove("active"));
  target.classList.add("active");
  document.querySelectorAll("main > section").forEach(s => s.style.display = "none");
  document.getElementById("view-" + viewName).style.display = "block";
  if (viewName === "categorias") renderCategorias();
  if (viewName === "historial") { renderScanHistory(); renderSearchHistory(); }
}

navItems.forEach(item => {
  item.addEventListener("click", () => switchView(item.dataset.view));
});

// ---------------- Productos / Stock (tiempo real) ----------------
const tbody = document.getElementById("products-tbody");
const emptyState = document.getElementById("products-empty");
const statTotal = document.getElementById("stat-total");
const statBajo = document.getElementById("stat-bajo");
const statCero = document.getElementById("stat-cero");
const statValor = document.getElementById("stat-valor");
const searchInput = document.getElementById("search-input");

let allProducts = [];

function startProductsListener() {
  const q = query(collection(db, "productos"), orderBy("nombre"));
  unsubProducts = onSnapshot(q, (snapshot) => {
    allProducts = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderProducts();
  }, (err) => {
    console.error(err);
    showToast("Error leyendo productos: " + err.message);
  });
}

function nivelDe(stock, minimo) {
  let pct = minimo > 0 ? Math.min(100, (stock / (minimo * 2)) * 100) : (stock > 0 ? 100 : 0);
  let color = "var(--green)";
  if (stock === 0) { color = "var(--red)"; pct = 100; }
  else if (stock <= minimo) { color = "var(--yellow)"; }
  return { pct, color };
}

function getAllCategoryNames() {
  const set = new Set(allCategorias.map(c => c.trim()).filter(Boolean));
  allProducts.forEach(p => { if (p.categoria) set.add(p.categoria.trim()); });
  return Array.from(set).sort((a, b) => a.localeCompare(b, "es"));
}

function populateCategoryFilter() {
  const sel = document.getElementById("search-categoria");
  if (!sel) return;
  const current = sel.value;
  const cats = getAllCategoryNames();
  sel.innerHTML = '<option value="">Todas las categorías</option>' +
    cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  if (cats.includes(current)) sel.value = current;
}

function renderProducts() {
  populateCategoryFilter();
  const term = searchInput.value.trim().toLowerCase();
  const catSel = document.getElementById("search-categoria");
  const catFilter = catSel ? catSel.value : "";
  const list = allProducts.filter(p => {
    const okTerm = !term ||
      p.nombre.toLowerCase().includes(term) ||
      (p.sku || "").toLowerCase().includes(term) ||
      (p.marca || "").toLowerCase().includes(term) ||
      (p.categoria || "").toLowerCase().includes(term);
    const okCat = !catFilter || (p.categoria || "").trim().toLowerCase() === catFilter.toLowerCase();
    return okTerm && okCat;
  });

  tbody.innerHTML = "";
  emptyState.style.display = list.length ? "none" : "block";

  let bajo = 0, cero = 0, valor = 0;

  list.forEach(p => {
    const stock = Number(p.stock) || 0;
    const minimo = Number(p.minimo) || 0;
    const precio = Number(p.precio) || 0;
    const costo = Number(p.costo) || 0;
    const precioRef = Number(p.precioReferencia) || 0;
    valor += stock * costo;
    if (stock === 0) cero++;
    else if (stock <= minimo) bajo++;

    const { pct, color } = nivelDe(stock, minimo);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="sku">${escapeHtml(p.sku || "—")}</td>
      <td style="font-weight:600;">${escapeHtml(p.nombre)}</td>
      <td>${escapeHtml(p.marca || "—")}</td>
      <td>${escapeHtml(p.categoria || "—")}</td>
      <td class="num">Bs ${costo.toFixed(2)}</td>
      <td class="num">Bs ${precioRef.toFixed(2)}</td>
      <td class="num">Bs ${precio.toFixed(2)}</td>
      <td class="num">${minimo}</td>
      <td class="num">${stock}</td>
      <td class="sku">${escapeHtml(p.codigoBarras || "—")}</td>
      <td><div class="gauge"><i style="width:${pct}%; background:${color};"></i></div></td>
      <td>
        <div class="row-actions">
          <button class="icon-btn" data-edit="${p.id}" title="Editar">✎</button>
          <button class="icon-btn danger" data-del="${p.id}" title="Eliminar">🗑</button>
        </div>
      </td>
    `;
    tbody.appendChild(tr);
  });

  statTotal.textContent = allProducts.length;
  statBajo.textContent = bajo;
  statCero.textContent = cero;
  statValor.textContent = "Bs " + valor.toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  renderStockView();
  renderInventario();
  renderCategorias();
}

searchInput.addEventListener("input", renderProducts);
searchInput.addEventListener("change", () => logSearchHistory(searchInput.value));
document.getElementById("search-categoria").addEventListener("change", renderProducts);

// ---------------- Vista Stock ----------------
const stockTbody = document.getElementById("stock-tbody");
const stockEmpty = document.getElementById("stock-empty");
const stockSearchInput = document.getElementById("stock-search-input");

function renderStockView() {
  if (!stockTbody) return;
  const term = stockSearchInput.value.trim().toLowerCase();
  const list = allProducts
    .filter(p => !term || p.nombre.toLowerCase().includes(term) || (p.sku || "").toLowerCase().includes(term))
    .slice()
    .sort((a, b) => (Number(a.stock) || 0) - (Number(b.stock) || 0));

  stockTbody.innerHTML = "";
  stockEmpty.style.display = list.length ? "none" : "block";

  let bajo = 0, cero = 0, valor = 0;
  list.forEach(p => {
    const stock = Number(p.stock) || 0;
    const minimo = Number(p.minimo) || 0;
    const costo = Number(p.costo) || 0;
    valor += stock * costo;
    if (stock === 0) cero++;
    else if (stock <= minimo) bajo++;

    let badge = `<span class="badge ok">OK</span>`;
    if (stock === 0) badge = `<span class="badge bad">Sin stock</span>`;
    else if (stock <= minimo) badge = `<span class="badge warn">Stock bajo</span>`;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="sku">${escapeHtml(p.sku || "—")}</td>
      <td style="font-weight:600;">${escapeHtml(p.nombre)}</td>
      <td class="num">${minimo}</td>
      <td class="num">${stock}</td>
      <td>${badge}</td>
      <td><button class="icon-btn" data-stock-edit="${p.id}" title="Editar">✎</button></td>
    `;
    stockTbody.appendChild(tr);
  });

  document.getElementById("stock-stat-total").textContent = allProducts.length;
  document.getElementById("stock-stat-bajo").textContent = bajo;
  document.getElementById("stock-stat-cero").textContent = cero;
  document.getElementById("stock-stat-valor").textContent = "Bs " + valor.toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
stockSearchInput?.addEventListener("input", renderStockView);
stockTbody?.addEventListener("click", (e) => {
  const id = e.target.closest("[data-stock-edit]")?.dataset.stockEdit;
  if (id) openProductModal(allProducts.find(p => p.id === id));
});

tbody.addEventListener("click", async (e) => {
  const editId = e.target.closest("[data-edit]")?.dataset.edit;
  const delId = e.target.closest("[data-del]")?.dataset.del;
  if (editId) openProductModal(allProducts.find(p => p.id === editId));
  if (delId) {
    const prod = allProducts.find(p => p.id === delId);
    if (confirm(`¿Eliminar "${prod?.nombre}" del inventario?`)) {
      await deleteDoc(doc(db, "productos", delId));
      showToast("Producto eliminado");
    }
  }
});

// ---------------- Modal producto ----------------
const modalBg = document.getElementById("product-modal-bg");
const modalTitle = document.getElementById("product-modal-title");
const productForm = document.getElementById("product-form");
const fId = document.getElementById("product-id");
const fNombre = document.getElementById("p-nombre");
const fSku = document.getElementById("p-sku");
const fCodigoBarras = document.getElementById("p-codigobarras");
const fMarca = document.getElementById("p-marca");
const fCategoria = document.getElementById("p-categoria");
const fPrecio = document.getElementById("p-precio");
const fRefPrecio = document.getElementById("p-refprecio");
const fCosto = document.getElementById("p-costo");
const fStock = document.getElementById("p-stock");
const fMinimo = document.getElementById("p-minimo");

document.getElementById("open-add-product").addEventListener("click", () => openProductModal(null));
document.getElementById("product-cancel").addEventListener("click", closeProductModal);
modalBg.addEventListener("click", (e) => { if (e.target === modalBg) closeProductModal(); });

function openProductModal(product, prefillCodigo) {
  productForm.reset();
  if (product) {
    modalTitle.textContent = "Editar producto";
    fId.value = product.id;
    fNombre.value = product.nombre || "";
    fSku.value = product.sku || "";
    fCodigoBarras.value = product.codigoBarras || "";
    fMarca.value = product.marca || "";
    fCategoria.value = product.categoria || "";
    fPrecio.value = product.precio ?? "";
    fRefPrecio.value = product.precioReferencia ?? "";
    fCosto.value = product.costo ?? "";
    fStock.value = product.stock ?? 0;
    fMinimo.value = product.minimo ?? 5;
  } else {
    modalTitle.textContent = "Nuevo producto";
    fId.value = "";
    fMinimo.value = 5;
    if (prefillCodigo) fSku.value = prefillCodigo;
  }
  modalBg.classList.add("active");
  fNombre.focus();
}
function closeProductModal() { modalBg.classList.remove("active"); }

productForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const saveBtn = document.getElementById("product-save");
  saveBtn.disabled = true;
  saveBtn.textContent = "Guardando...";

  const data = {
    nombre: fNombre.value.trim(),
    sku: fSku.value.trim(),
    codigoBarras: fCodigoBarras.value.trim(),
    marca: fMarca.value.trim(),
    categoria: fCategoria.value.trim(),
    precio: Number(fPrecio.value),
    precioReferencia: Number(fRefPrecio.value) || 0,
    costo: Number(fCosto.value),
    stock: Number(fStock.value),
    minimo: Number(fMinimo.value),
    actualizadoEn: serverTimestamp()
  };

  // Validación: no se pueden duplicar productos por código.
  // Si el código ya existe, el stock y el código de barras se actualizan desde Inventario.
  if (!fId.value && data.sku) {
    const dup = allProducts.find(p => (p.sku || "").trim().toUpperCase() === data.sku.toUpperCase());
    if (dup) {
      showToast("Ya existe un producto con ese código. Actualiza su cantidad desde Inventario.");
      saveBtn.disabled = false;
      saveBtn.textContent = "Guardar";
      return;
    }
  }

  try {
    if (fId.value) {
      await updateDoc(doc(db, "productos", fId.value), data);
      showToast("Producto actualizado");
    } else {
      data.creadoEn = serverTimestamp();
      await addDoc(collection(db, "productos"), data);
      showToast("Producto agregado");
    }
    closeProductModal();
  } catch (err) {
    console.error(err);
    showToast("Error al guardar: " + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Guardar";
  }
});

// ---------------- Compras (tiempo real) ----------------
let allCompras = [];

const comprasTbody = document.getElementById("compras-tbody");
const comprasEmpty = document.getElementById("compras-empty");
const statComprasMes = document.getElementById("stat-compras-mes");
const statComprasValor = document.getElementById("stat-compras-valor");

function startComprasListener() {
  const q = query(collection(db, "compras"), orderBy("fecha", "desc"));
  unsubCompras = onSnapshot(q, (snapshot) => {
    allCompras = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderCompras();
  }, (err) => {
    console.error(err);
    showToast("Error leyendo compras: " + err.message);
  });
}

function renderCompras() {
  comprasTbody.innerHTML = "";
  comprasEmpty.style.display = allCompras.length ? "none" : "block";

  const now = new Date();
  let mesCount = 0, mesValor = 0;

  allCompras.forEach(c => {
    const fecha = c.fecha?.toDate ? c.fecha.toDate() : new Date();
    const total = (Number(c.cantidad) || 0) * (Number(c.costoUnitario) || 0);
    if (fecha.getMonth() === now.getMonth() && fecha.getFullYear() === now.getFullYear()) {
      mesCount++;
      mesValor += total;
    }
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fecha.toLocaleDateString("es-BO")}</td>
      <td class="mono">${fecha.toLocaleTimeString("es-BO", { hour: "2-digit", minute: "2-digit" })}</td>
      <td style="font-weight:600;">${escapeHtml(c.productoNombre)}</td>
      <td>${escapeHtml(c.proveedor || "—")}</td>
      <td class="num">${c.cantidad}</td>
      <td class="num">Bs ${Number(c.costoUnitario).toFixed(2)}</td>
      <td class="num">Bs ${total.toFixed(2)}</td>
      <td class="sku">${escapeHtml(c.registradoPor || "—")}</td>
    `;
    comprasTbody.appendChild(tr);
  });

  statComprasMes.textContent = mesCount;
  statComprasValor.textContent = "Bs " + mesValor.toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------------- Modal compra ----------------
const compraModalBg = document.getElementById("compra-modal-bg");
const compraForm = document.getElementById("compra-form");
const cProducto = document.getElementById("c-producto");
const cProveedor = document.getElementById("c-proveedor");
const cCantidad = document.getElementById("c-cantidad");
const cCosto = document.getElementById("c-costo");
const cPrecioRef = document.getElementById("c-precio-ref");
const cPrecioVenta = document.getElementById("c-precio-venta");
const cActualizarCosto = document.getElementById("c-actualizar-costo");
const cActualizarRef = document.getElementById("c-actualizar-ref");
const cActualizarVenta = document.getElementById("c-actualizar-venta");

function fillCompraFieldsFromProducto(productoId) {
  const p = allProducts.find(pr => pr.id === productoId);
  if (!p) return;
  cCosto.value = p.costo ?? 0;
  cPrecioRef.value = p.precioReferencia ?? 0;
  cPrecioVenta.value = p.precio ?? 0;
}
cProducto.addEventListener("change", () => fillCompraFieldsFromProducto(cProducto.value));

function openCompraModal(prefillProductId) {
  if (!allProducts.length) {
    showToast("Primero agrega al menos un producto en la sección Productos");
    return;
  }
  compraForm.reset();
  cActualizarCosto.checked = true;
  cActualizarRef.checked = false;
  cActualizarVenta.checked = false;
  cProducto.innerHTML = allProducts.map(p => `<option value="${p.id}">${escapeHtml(p.sku ? p.sku + " · " : "")}${escapeHtml(p.nombre)}</option>`).join("");
  if (prefillProductId) cProducto.value = prefillProductId;
  fillCompraFieldsFromProducto(cProducto.value);
  compraModalBg.classList.add("active");
}

document.getElementById("open-add-compra").addEventListener("click", () => openCompraModal());
document.getElementById("compra-cancel").addEventListener("click", () => compraModalBg.classList.remove("active"));
compraModalBg.addEventListener("click", (e) => { if (e.target === compraModalBg) compraModalBg.classList.remove("active"); });

compraForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const saveBtn = document.getElementById("compra-save");
  saveBtn.disabled = true;
  saveBtn.textContent = "Registrando...";

  const productoId = cProducto.value;
  const producto = allProducts.find(p => p.id === productoId);
  const cantidad = Number(cCantidad.value);
  const costoUnitario = Number(cCosto.value);
  const precioRefNuevo = Number(cPrecioRef.value) || 0;
  const precioVentaNuevo = Number(cPrecioVenta.value) || 0;

  try {
    // 1. Registrar la compra en el historial
    await addDoc(collection(db, "compras"), {
      productoId,
      productoNombre: producto.nombre,
      proveedor: cProveedor.value.trim(),
      cantidad,
      costoUnitario,
      precioReferencia: precioRefNuevo,
      precioVenta: precioVentaNuevo,
      fecha: serverTimestamp(),
      registradoPor: currentUser?.email || "—"
    });

    // 2. Sumar el stock del producto (y opcionalmente actualizar sus precios)
    const updateData = { stock: increment(cantidad) };
    if (cActualizarCosto.checked) updateData.costo = costoUnitario;
    if (cActualizarRef.checked) updateData.precioReferencia = precioRefNuevo;
    if (cActualizarVenta.checked) updateData.precio = precioVentaNuevo;
    await updateDoc(doc(db, "productos", productoId), updateData);

    showToast(`Stock de "${producto.nombre}" actualizado (+${cantidad})`);
    compraModalBg.classList.remove("active");
  } catch (err) {
    console.error(err);
    showToast("Error al registrar la compra: " + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Registrar";
  }
});

// ---------------- Caja (turno activo en tiempo real) ----------------
let currentTurno = null; // {id, ...data}
let allMovimientos = [];

const cajaCerradaView = document.getElementById("caja-cerrada-view");
const cajaAbiertaView = document.getElementById("caja-abierta-view");
const cajaCerradaBanner = document.getElementById("caja-cerrada-banner");
const ventasContent = document.getElementById("ventas-content");

function startTurnoListener() {
  const q = query(collection(db, "caja_turnos"), where("estado", "==", "abierta"));
  unsubTurno = onSnapshot(q, (snapshot) => {
    if (snapshot.empty) {
      currentTurno = null;
      cajaCerradaView.style.display = "block";
      cajaAbiertaView.style.display = "none";
      cajaCerradaBanner.style.display = "block";
      ventasContent.style.display = "none";
      if (unsubMovimientos) { unsubMovimientos(); unsubMovimientos = null; allMovimientos = []; }
    } else {
      const d = snapshot.docs[0];
      currentTurno = { id: d.id, ...d.data() };
      cajaCerradaView.style.display = "none";
      cajaAbiertaView.style.display = "block";
      cajaCerradaBanner.style.display = "none";
      ventasContent.style.display = "block";
      document.getElementById("caja-inicial").textContent = "Bs " + Number(currentTurno.montoInicial).toFixed(2);
      if (!unsubMovimientos) startMovimientosListener();
    }
  });
}

function startMovimientosListener() {
  const q = query(collection(db, "caja_movimientos"), where("turnoId", "==", currentTurno.id), orderBy("fecha", "desc"));
  unsubMovimientos = onSnapshot(q, (snapshot) => {
    allMovimientos = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderCajaTotales();
  });
}

function renderCajaTotales() {
  const tbodyMov = document.getElementById("movimientos-tbody");
  const empty = document.getElementById("movimientos-empty");
  tbodyMov.innerHTML = "";

  let ventasEfectivo = 0, ingresos = 0, egresos = 0;
  const manuales = allMovimientos.filter(m => m.tipo === "ingreso" || m.tipo === "egreso");
  empty.style.display = manuales.length ? "none" : "block";

  allMovimientos.forEach(m => {
    const hora = m.fecha?.toDate ? m.fecha.toDate() : new Date();
    if (m.tipo === "venta") { ventasEfectivo += Number(m.monto); return; }
    if (m.tipo === "ingreso") ingresos += Number(m.monto);
    if (m.tipo === "egreso") egresos += Number(m.monto);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${hora.toLocaleTimeString("es-BO", { hour: "2-digit", minute: "2-digit" })}</td>
      <td style="text-transform:capitalize;">${m.tipo}</td>
      <td>${escapeHtml(m.motivo || "—")}</td>
      <td class="num" style="color:${m.tipo === "egreso" ? "var(--red)" : "var(--green)"};">${m.tipo === "egreso" ? "-" : "+"}Bs ${Number(m.monto).toFixed(2)}</td>
      <td class="sku">${escapeHtml(m.registradoPor || "—")}</td>
    `;
    tbodyMov.appendChild(tr);
  });

  const inicial = Number(currentTurno?.montoInicial) || 0;
  const esperado = inicial + ventasEfectivo + ingresos - egresos;

  document.getElementById("caja-ventas").textContent = "Bs " + ventasEfectivo.toFixed(2);
  document.getElementById("caja-ingresos").textContent = "Bs " + ingresos.toFixed(2);
  document.getElementById("caja-egresos").textContent = "Bs " + egresos.toFixed(2);
  document.getElementById("caja-esperado").textContent = "Bs " + esperado.toFixed(2);
}

// abrir caja
document.getElementById("open-abrir-caja").addEventListener("click", () => {
  document.getElementById("abrir-caja-form").reset();
  document.getElementById("abrir-caja-modal-bg").classList.add("active");
});
document.getElementById("abrir-caja-cancel").addEventListener("click", () => document.getElementById("abrir-caja-modal-bg").classList.remove("active"));
document.getElementById("abrir-caja-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const monto = Number(document.getElementById("ac-monto").value);
  await addDoc(collection(db, "caja_turnos"), {
    estado: "abierta",
    montoInicial: monto,
    abiertaPor: currentUser?.email || "—",
    fechaApertura: serverTimestamp()
  });
  document.getElementById("abrir-caja-modal-bg").classList.remove("active");
  showToast("Caja abierta");
});

// movimiento manual
document.getElementById("open-movimiento").addEventListener("click", () => {
  document.getElementById("movimiento-form").reset();
  document.getElementById("movimiento-modal-bg").classList.add("active");
});
document.getElementById("movimiento-cancel").addEventListener("click", () => document.getElementById("movimiento-modal-bg").classList.remove("active"));
document.getElementById("movimiento-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  await addDoc(collection(db, "caja_movimientos"), {
    turnoId: currentTurno.id,
    tipo: document.getElementById("mv-tipo").value,
    motivo: document.getElementById("mv-motivo").value.trim(),
    monto: Number(document.getElementById("mv-monto").value),
    fecha: serverTimestamp(),
    registradoPor: currentUser?.email || "—"
  });
  document.getElementById("movimiento-modal-bg").classList.remove("active");
  showToast("Movimiento registrado");
});

// cerrar caja
document.getElementById("open-cerrar-caja").addEventListener("click", () => {
  document.getElementById("cerrar-caja-form").reset();
  document.getElementById("cc-esperado-txt").textContent = document.getElementById("caja-esperado").textContent;
  document.getElementById("cerrar-caja-modal-bg").classList.add("active");
});
document.getElementById("cerrar-caja-cancel").addEventListener("click", () => document.getElementById("cerrar-caja-modal-bg").classList.remove("active"));
document.getElementById("cerrar-caja-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const esperado = Number(document.getElementById("caja-esperado").textContent.replace("Bs ", "").replace(/,/g, ""));
  const contado = Number(document.getElementById("cc-contado").value);
  await updateDoc(doc(db, "caja_turnos", currentTurno.id), {
    estado: "cerrada",
    montoFinalEsperado: esperado,
    montoFinalContado: contado,
    diferencia: contado - esperado,
    fechaCierre: serverTimestamp(),
    cerradaPor: currentUser?.email || "—"
  });
  document.getElementById("cerrar-caja-modal-bg").classList.remove("active");
  showToast("Caja cerrada");
});

// ---------------- Ventas ----------------
let cart = []; // {productoId, nombre, precio, cantidad, stockDisponible}

const ventaSearch = document.getElementById("venta-search");
const ventaResults = document.getElementById("venta-search-results");
const cartTbody = document.getElementById("cart-tbody");
const cartEmpty = document.getElementById("cart-empty");
const cartTotalEl = document.getElementById("cart-total");

ventaSearch.addEventListener("input", () => {
  const term = ventaSearch.value.trim().toLowerCase();
  ventaResults.innerHTML = "";
  if (!term) return;
  const matches = allProducts.filter(p =>
    p.nombre.toLowerCase().includes(term) || (p.sku || "").toLowerCase().includes(term)
  ).slice(0, 8);
  matches.forEach(p => {
    const row = document.createElement("div");
    row.style.cssText = "display:flex; justify-content:space-between; align-items:center; padding:10px 18px; border-bottom:1px solid #F0EEE7; cursor:pointer;";
    row.innerHTML = `<div><b>${escapeHtml(p.nombre)}</b> <span class="sku">${escapeHtml(p.sku || "")}</span></div><div class="mono">Bs ${Number(p.precio).toFixed(2)} · stock ${p.stock}</div>`;
    row.addEventListener("click", () => { addToCart(p); ventaSearch.value = ""; ventaResults.innerHTML = ""; });
    row.addEventListener("mouseenter", () => row.style.background = "#FAF9F5");
    row.addEventListener("mouseleave", () => row.style.background = "transparent");
    ventaResults.appendChild(row);
  });
});

function addToCart(product) {
  if (Number(product.stock) <= 0) { showToast("Sin stock disponible"); return; }
  const existing = cart.find(i => i.productoId === product.id);
  if (existing) {
    if (existing.cantidad >= product.stock) { showToast("No hay más stock de este producto"); return; }
    existing.cantidad++;
  } else {
    cart.push({
      productoId: product.id,
      nombre: product.nombre,
      precio: Number(product.precio),
      costoUnit: Number(product.costo) || 0,
      cantidad: 1,
      stockDisponible: Number(product.stock)
    });
  }
  renderCart();
}

function renderCart() {
  cartTbody.innerHTML = "";
  cartEmpty.style.display = cart.length ? "none" : "block";
  let total = 0;
  cart.forEach((item, idx) => {
    const subtotal = item.precio * item.cantidad;
    total += subtotal;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="font-weight:600;">${escapeHtml(item.nombre)}</td>
      <td class="num"><input type="number" min="1" max="${item.stockDisponible}" value="${item.cantidad}" data-qty="${idx}" style="width:60px; padding:5px; border-radius:5px; border:1px solid var(--line); font-family:inherit;"></td>
      <td class="num"><input type="number" min="0" step="0.01" value="${item.precio}" data-price="${idx}" style="width:80px; padding:5px; border-radius:5px; border:1px solid var(--line); font-family:inherit;"></td>
      <td class="num">Bs ${subtotal.toFixed(2)}</td>
      <td><button class="icon-btn danger" data-rm="${idx}">🗑</button></td>
    `;
    cartTbody.appendChild(tr);
  });
  cartTotalEl.textContent = "Bs " + total.toFixed(2);
}

cartTbody.addEventListener("click", (e) => {
  const rm = e.target.closest("[data-rm]")?.dataset.rm;
  if (rm !== undefined) { cart.splice(Number(rm), 1); renderCart(); }
});
cartTbody.addEventListener("change", (e) => {
  const qtyIdx = e.target.dataset.qty;
  const priceIdx = e.target.dataset.price;
  if (qtyIdx !== undefined) {
    let val = Number(e.target.value);
    const item = cart[qtyIdx];
    if (val > item.stockDisponible) { val = item.stockDisponible; showToast("Stock máximo disponible: " + val); }
    if (val < 1) val = 1;
    item.cantidad = val;
    renderCart();
  }
  if (priceIdx !== undefined) {
    let val = Number(e.target.value);
    if (val < 0 || isNaN(val)) val = 0;
    cart[priceIdx].precio = val;
    renderCart();
  }
});

document.getElementById("confirm-venta-btn").addEventListener("click", async () => {
  if (!cart.length) { showToast("El carrito está vacío"); return; }
  if (!currentTurno) { showToast("Abre la caja antes de vender"); return; }
  const btn = document.getElementById("confirm-venta-btn");
  btn.disabled = true; btn.textContent = "Procesando...";

  const metodo = document.getElementById("venta-metodo").value;
  const total = cart.reduce((s, i) => s + i.precio * i.cantidad, 0);
  const ganancia = cart.reduce((s, i) => s + (i.precio - (i.costoUnit || 0)) * i.cantidad, 0);

  try {
    await addDoc(collection(db, "ventas"), {
      items: cart.map(i => ({ productoId: i.productoId, nombre: i.nombre, precio: i.precio, costoUnit: i.costoUnit || 0, cantidad: i.cantidad })),
      total,
      ganancia,
      metodoPago: metodo,
      turnoId: currentTurno.id,
      vendedor: currentUser?.email || "—",
      fecha: serverTimestamp()
    });

    for (const item of cart) {
      await updateDoc(doc(db, "productos", item.productoId), { stock: increment(-item.cantidad) });
    }

    if (metodo === "efectivo") {
      await addDoc(collection(db, "caja_movimientos"), {
        turnoId: currentTurno.id,
        tipo: "venta",
        motivo: "Venta en efectivo",
        monto: total,
        fecha: serverTimestamp(),
        registradoPor: currentUser?.email || "—"
      });
    }

    cart = [];
    renderCart();
    showToast("Venta registrada por Bs " + total.toFixed(2));
  } catch (err) {
    console.error(err);
    showToast("Error al registrar la venta: " + err.message);
  } finally {
    btn.disabled = false; btn.textContent = "Cobrar venta";
  }
});

// ---------------- Historial de ventas (tiempo real) ----------------
let allVentas = [];
const ventasTbody = document.getElementById("ventas-tbody");
const ventasEmpty = document.getElementById("ventas-empty");

function startVentasListener() {
  const q = query(collection(db, "ventas"), orderBy("fecha", "desc"));
  unsubVentas = onSnapshot(q, (snapshot) => {
    allVentas = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderVentasHistorial();
  }, (err) => {
    console.error(err);
    showToast("Error leyendo ventas: " + err.message);
  });
}

function renderVentasHistorial() {
  if (!ventasTbody) return;
  ventasTbody.innerHTML = "";
  ventasEmpty.style.display = allVentas.length ? "none" : "block";

  const now = new Date();
  let mesCount = 0, mesTotal = 0, mesGanancia = 0;

  allVentas.forEach(v => {
    const fecha = v.fecha?.toDate ? v.fecha.toDate() : new Date();
    const total = Number(v.total) || 0;
    const ganancia = v.ganancia !== undefined
      ? Number(v.ganancia)
      : (v.items || []).reduce((s, i) => s + (Number(i.precio) - Number(i.costoUnit || 0)) * Number(i.cantidad), 0);

    if (fecha.getMonth() === now.getMonth() && fecha.getFullYear() === now.getFullYear()) {
      mesCount++;
      mesTotal += total;
      mesGanancia += ganancia;
    }

    const itemsResumen = (v.items || []).map(i => `${i.cantidad}× ${i.nombre}`).join(", ");
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fecha.toLocaleDateString("es-BO")}</td>
      <td class="mono">${fecha.toLocaleTimeString("es-BO", { hour: "2-digit", minute: "2-digit" })}</td>
      <td style="max-width:260px;">${escapeHtml(itemsResumen)}</td>
      <td class="num">Bs ${total.toFixed(2)}</td>
      <td class="num" style="color:var(--green);">Bs ${ganancia.toFixed(2)}</td>
      <td style="text-transform:capitalize;">${escapeHtml(v.metodoPago || "—")}</td>
      <td class="sku">${escapeHtml(v.vendedor || "—")}</td>
    `;
    ventasTbody.appendChild(tr);
  });

  const elMes = document.getElementById("stat-ventas-mes");
  const elTotal = document.getElementById("stat-ventas-total");
  const elGan = document.getElementById("stat-ventas-ganancia");
  if (elMes) elMes.textContent = mesCount;
  if (elTotal) elTotal.textContent = "Bs " + mesTotal.toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (elGan) elGan.textContent = "Bs " + mesGanancia.toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------------- Gastos extra (tiempo real) ----------------
let allGastos = [];
const gastosTbody = document.getElementById("gastos-tbody");
const gastosEmpty = document.getElementById("gastos-empty");

function startGastosListener() {
  const q = query(collection(db, "gastos"), orderBy("fecha", "desc"));
  unsubGastos = onSnapshot(q, (snapshot) => {
    allGastos = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderGastos();
  }, (err) => {
    console.error(err);
    showToast("Error leyendo gastos: " + err.message);
  });
}

function renderGastos() {
  if (!gastosTbody) return;
  gastosTbody.innerHTML = "";
  gastosEmpty.style.display = allGastos.length ? "none" : "block";

  const now = new Date();
  let mesCount = 0, mesValor = 0;

  allGastos.forEach(g => {
    const fecha = g.fecha?.toDate ? g.fecha.toDate() : new Date();
    const monto = Number(g.monto) || 0;
    if (fecha.getMonth() === now.getMonth() && fecha.getFullYear() === now.getFullYear()) {
      mesCount++;
      mesValor += monto;
    }
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fecha.toLocaleDateString("es-BO")}</td>
      <td class="mono">${fecha.toLocaleTimeString("es-BO", { hour: "2-digit", minute: "2-digit" })}</td>
      <td>${escapeHtml(g.observacion || "—")}</td>
      <td class="num" style="color:var(--red);">Bs ${monto.toFixed(2)}</td>
      <td class="sku">${escapeHtml(g.registradoPor || "—")}</td>
      <td><button class="icon-btn danger" data-del-gasto="${g.id}" title="Eliminar">🗑</button></td>
    `;
    gastosTbody.appendChild(tr);
  });

  document.getElementById("stat-gastos-mes").textContent = mesCount;
  document.getElementById("stat-gastos-valor").textContent = "Bs " + mesValor.toLocaleString("es-BO", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

gastosTbody?.addEventListener("click", async (e) => {
  const delId = e.target.closest("[data-del-gasto]")?.dataset.delGasto;
  if (delId && confirm("¿Eliminar este gasto?")) {
    await deleteDoc(doc(db, "gastos", delId));
    showToast("Gasto eliminado");
  }
});

const gastoModalBg = document.getElementById("gasto-modal-bg");
const gastoForm = document.getElementById("gasto-form");
document.getElementById("open-add-gasto").addEventListener("click", () => {
  gastoForm.reset();
  gastoModalBg.classList.add("active");
});
document.getElementById("gasto-cancel").addEventListener("click", () => gastoModalBg.classList.remove("active"));
gastoModalBg.addEventListener("click", (e) => { if (e.target === gastoModalBg) gastoModalBg.classList.remove("active"); });
gastoForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const saveBtn = document.getElementById("gasto-save");
  saveBtn.disabled = true;
  saveBtn.textContent = "Registrando...";
  try {
    await addDoc(collection(db, "gastos"), {
      observacion: document.getElementById("g-obs").value.trim(),
      monto: Number(document.getElementById("g-monto").value),
      fecha: serverTimestamp(),
      registradoPor: currentUser?.email || "—"
    });
    gastoModalBg.classList.remove("active");
    showToast("Gasto registrado");
  } catch (err) {
    console.error(err);
    showToast("Error al registrar el gasto: " + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Registrar";
  }
});

// ---------------- Categorías ----------------
let allCategorias = [];

function startCategoriasListener() {
  const q = query(collection(db, "categorias"), orderBy("nombre"));
  unsubCategorias = onSnapshot(q, (snapshot) => {
    allCategorias = snapshot.docs.map(d => d.data().nombre).filter(Boolean);
    renderProducts();
  }, (err) => {
    console.error(err);
  });
}

function renderCategorias() {
  const grid = document.getElementById("categorias-grid");
  if (!grid) return;
  const cats = getAllCategoryNames();
  if (!cats.length) {
    grid.innerHTML = `<p style="color:var(--ink-soft);">Aún no hay categorías. Crea productos con categoría o agrega una arriba.</p>`;
    return;
  }
  grid.innerHTML = cats.map(c => {
    const count = allProducts.filter(p => (p.categoria || "").trim().toLowerCase() === c.toLowerCase()).length;
    return `
      <div class="cat-card" data-cat="${escapeHtml(c)}">
        <div class="label">${escapeHtml(c)}</div>
        <div class="value">${count}</div>
      </div>`;
  }).join("");
  grid.querySelectorAll("[data-cat]").forEach(el => {
    el.addEventListener("click", () => {
      const sel = document.getElementById("search-categoria");
      if (sel) sel.value = el.dataset.cat;
      switchView("productos");
      renderProducts();
    });
  });
}

document.getElementById("btn-add-categoria").addEventListener("click", async () => {
  const input = document.getElementById("nueva-categoria-input");
  const val = input.value.trim();
  if (!val) { showToast("Escribe un nombre de categoría"); return; }
  try {
    await addDoc(collection(db, "categorias"), { nombre: val, creadoEn: serverTimestamp() });
    input.value = "";
    showToast("Categoría agregada");
  } catch (err) {
    console.error(err);
    showToast("Error: " + err.message);
  }
});

// ---------------- Historial (escaneos y búsquedas) ----------------
let allScans = [];
let allBuscados = [];

function startHistorialListeners() {
  unsubHistorial = onSnapshot(
    query(collection(db, "historial_escaneos"), orderBy("fecha", "desc"), limit(300)),
    (snap) => { allScans = snap.docs.map(d => ({ id: d.id, ...d.data() })); renderScanHistory(); },
    (err) => console.error(err)
  );
  unsubHistorialBusquedas = onSnapshot(
    query(collection(db, "historial_busquedas"), orderBy("fecha", "desc"), limit(200)),
    (snap) => { allBuscados = snap.docs.map(d => ({ id: d.id, ...d.data() })); renderSearchHistory(); },
    (err) => console.error(err)
  );
}

async function logScanHistory(codigo) {
  const p = findProductByCodigo(codigo);
  try {
    await addDoc(collection(db, "historial_escaneos"), {
      codigo: String(codigo),
      encontrado: !!p,
      nombre: p ? p.nombre : "",
      fecha: serverTimestamp(),
      userId: currentUser?.uid || "",
      usuario: currentUser?.email || ""
    });
  } catch (err) { console.error(err); }
}

async function logSearchHistory(query) {
  query = (query || "").trim();
  if (!query) return;
  try {
    await addDoc(collection(db, "historial_busquedas"), {
      query,
      fecha: serverTimestamp(),
      userId: currentUser?.uid || "",
      usuario: currentUser?.email || ""
    });
  } catch (err) { console.error(err); }
}

function renderScanHistory() {
  const tbodyH = document.getElementById("scan-history-tbody");
  const empty = document.getElementById("scan-history-empty");
  if (!tbodyH) return;
  const mine = allScans.filter(h => h.userId === currentUser?.uid);
  tbodyH.innerHTML = "";
  empty.style.display = mine.length ? "none" : "block";
  mine.slice(0, 100).forEach(h => {
    const fecha = h.fecha?.toDate ? h.fecha.toDate() : new Date();
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong class="mono">${escapeHtml(h.codigo)}</strong></td>
      <td>${escapeHtml(h.nombre || "—")}</td>
      <td>${h.encontrado ? '<span class="badge ok">Encontrado</span>' : '<span class="badge bad">No encontrado</span>'}</td>
      <td>${fecha.toLocaleString("es-BO", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" })}</td>
    `;
    tbodyH.appendChild(tr);
  });
}

function renderSearchHistory() {
  const list = document.getElementById("search-history-list");
  const empty = document.getElementById("search-history-empty");
  if (!list) return;
  const mine = allBuscados.filter(h => h.userId === currentUser?.uid);
  list.innerHTML = "";
  empty.style.display = mine.length ? "none" : "block";
  mine.slice(0, 80).forEach(h => {
    const fecha = h.fecha?.toDate ? h.fecha.toDate() : new Date();
    const row = document.createElement("div");
    row.style.cssText = "display:flex; justify-content:space-between; align-items:center; gap:10px; padding:11px 18px; border-bottom:1px dashed var(--line); font-size:13.5px;";
    row.innerHTML = `<span>🔍 ${escapeHtml(h.query)}</span><small style="color:var(--ink-soft); white-space:nowrap;">${fecha.toLocaleString("es-BO", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" })}</small>`;
    list.appendChild(row);
  });
}

document.getElementById("btn-clear-scan-history").addEventListener("click", async () => {
  const mine = allScans.filter(h => h.userId === currentUser?.uid);
  if (!mine.length) { showToast("No hay escaneos que borrar"); return; }
  if (!confirm("¿Borrar tu historial de escaneos?")) return;
  const batch = writeBatch(db);
  mine.forEach(h => batch.delete(doc(db, "historial_escaneos", h.id)));
  await batch.commit();
  showToast("Historial de escaneos borrado");
});

document.getElementById("btn-clear-search-history").addEventListener("click", async () => {
  const mine = allBuscados.filter(h => h.userId === currentUser?.uid);
  if (!mine.length) { showToast("No hay búsquedas que borrar"); return; }
  if (!confirm("¿Borrar tu historial de búsquedas?")) return;
  const batch = writeBatch(db);
  mine.forEach(h => batch.delete(doc(db, "historial_busquedas", h.id)));
  await batch.commit();
  showToast("Historial de búsquedas borrado");
});

// ---------------- Vista Inventario ----------------
const invTbody = document.getElementById("inventario-tbody");
const invEmpty = document.getElementById("inventario-empty");
const invSearch = document.getElementById("inv-search");

function renderInventario() {
  if (!invTbody) return;
  const term = invSearch.value.trim().toLowerCase();
  const list = allProducts.filter(p =>
    !term || (p.sku || "").toLowerCase().includes(term) || p.nombre.toLowerCase().includes(term)
  ).slice().sort((a, b) => (a.sku || "").localeCompare(b.sku || "", "es"));

  invTbody.innerHTML = "";
  invEmpty.style.display = list.length ? "none" : "block";

  list.forEach(p => {
    const stock = Number(p.stock) || 0;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="sku">${escapeHtml(p.sku || "—")}</td>
      <td style="font-weight:600;">${escapeHtml(p.nombre)}</td>
      <td class="num">${stock}</td>
      <td class="sku">${escapeHtml(p.codigoBarras || "—")}</td>
      <td><div class="row-actions"><button class="icon-btn" data-inv-edit="${p.id}" title="Registrar cantidad">✎</button></div></td>
    `;
    invTbody.appendChild(tr);
  });
}

invSearch.addEventListener("input", renderInventario);
invTbody.addEventListener("click", (e) => {
  const id = e.target.closest("[data-inv-edit]")?.dataset.invEdit;
  if (id) openInventoryModal(allProducts.find(p => p.id === id), null);
});

document.getElementById("open-registrar-inventario").addEventListener("click", () => openScanner("inventario"));
document.getElementById("open-export-inventario").addEventListener("click", exportInventarioCSV);

// ---------------- Modal registrar cantidad de inventario ----------------
let invTargetProduct = null;
let invScannedCode = "";

const inventoryModalBg = document.getElementById("inventory-modal-bg");
const inventoryForm = document.getElementById("inventory-form");
const inventoryModalTitle = document.getElementById("inventory-modal-title");
const inventoryProductInfo = document.getElementById("inventory-product-info");
const invCantidad = document.getElementById("inv-cantidad");
const invCodigoBarras = document.getElementById("inv-codigo-barras");

function openInventoryModal(product, codigo) {
  invTargetProduct = product || null;
  invScannedCode = codigo || (product ? (product.sku || "") : "");
  inventoryForm.reset();
  const crearWrap = document.getElementById("inv-crear-nuevo-wrap");
  const fields = document.getElementById("inv-fields");
  const saveBtn = document.getElementById("inventory-save");

  if (product) {
    inventoryModalTitle.textContent = "Registrar cantidad de inventario";
    inventoryProductInfo.innerHTML = `
      <div class="scan-result-card">
        <div class="rc-title">✔ Producto encontrado</div>
        <dl>
          <dt>Código</dt><dd>${escapeHtml(product.sku || "—")}</dd>
          <dt>Descripción</dt><dd style="font-family:inherit;">${escapeHtml(product.nombre)}</dd>
          <dt>Marca</dt><dd style="font-family:inherit;">${escapeHtml(product.marca || "—")}</dd>
          <dt>Categoría</dt><dd style="font-family:inherit;">${escapeHtml(product.categoria || "—")}</dd>
          <dt>Stock actual</dt><dd>${Number(product.stock) || 0}</dd>
        </dl>
      </div>`;
    invCantidad.value = product.stock ?? 0;
    invCodigoBarras.value = product.codigoBarras || "";
    fields.style.display = "";
    saveBtn.style.display = "";
    crearWrap.style.display = "none";
  } else {
    inventoryModalTitle.textContent = "Código no encontrado";
    inventoryProductInfo.innerHTML = `
      <div class="scan-result-card">
        <div class="rc-title">⚠️ Código no encontrado</div>
        <p style="margin:0 0 6px; font-size:13px; color:var(--ink-soft);">No hay ningún producto con el código:</p>
        <span class="scan-code-pill">${escapeHtml(invScannedCode)}</span>
      </div>`;
    invCantidad.value = 0;
    fields.style.display = "none";
    saveBtn.style.display = "none";
    crearWrap.style.display = "block";
  }
  inventoryModalBg.classList.add("active");
}

function closeInventoryModal() { inventoryModalBg.classList.remove("active"); }

document.getElementById("inventory-cancel").addEventListener("click", closeInventoryModal);
inventoryModalBg.addEventListener("click", (e) => { if (e.target === inventoryModalBg) closeInventoryModal(); });

document.getElementById("inv-crear-nuevo").addEventListener("click", () => {
  closeInventoryModal();
  switchView("productos");
  openProductModal(null, invScannedCode);
});

inventoryForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!invTargetProduct) { showToast("Primero crea el producto"); return; }
  const saveBtn = document.getElementById("inventory-save");
  saveBtn.disabled = true;
  saveBtn.textContent = "Guardando...";
  const cantidad = Number(invCantidad.value);
  const codigoBarras = invCodigoBarras.value.trim();
  try {
    await updateDoc(doc(db, "productos", invTargetProduct.id), {
      stock: cantidad,
      codigoBarras: codigoBarras || invTargetProduct.codigoBarras || "",
      actualizadoEn: serverTimestamp()
    });
    showToast(`Stock de "${invTargetProduct.nombre}" actualizado a ${cantidad}`);
    closeInventoryModal();
  } catch (err) {
    console.error(err);
    showToast("Error al guardar: " + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Guardar";
  }
});

// ---------------- Exportar CSV ----------------
document.getElementById("open-export-products").addEventListener("click", exportProductsCSV);

function downloadCSV(cols, rows, baseName) {
  const escape = (v) => {
    const s = String(v ?? "");
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = "\uFEFF" + [cols.join(","), ...rows.map(r => r.map(escape).join(","))].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${baseName}_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportProductsCSV() {
  const cols = ["CODIGO", "DESCRIPCION", "MARCA", "CATEGORIA", "PRECIO COMPRA", "PRECIO REFERENCIA", "PRECIO VENTA", "STOCK MINIMO", "STOCK ACTUAL", "CODIGO BARRAS"];
  const rows = allProducts.map(p => [
    p.sku || "", p.nombre || "", p.marca || "", p.categoria || "",
    p.costo ?? 0, p.precioReferencia ?? 0, p.precio ?? 0,
    p.minimo ?? 0, p.stock ?? 0, p.codigoBarras || ""
  ]);
  downloadCSV(cols, rows, "productos");
}

function exportInventarioCSV() {
  const cols = ["CODIGO", "DESCRIPCION", "MARCA", "CATEGORIA", "CANTIDAD", "CODIGO BARRAS"];
  const rows = allProducts.map(p => [
    p.sku || "", p.nombre || "", p.marca || "", p.categoria || "",
    p.stock ?? 0, p.codigoBarras || ""
  ]);
  downloadCSV(cols, rows, "inventario");
}

// ---------------- Importar productos desde Excel ----------------
const importModalBg = document.getElementById("import-modal-bg");
const importFile = document.getElementById("import-file");
const importStockInicial = document.getElementById("import-stock-inicial");
const importPreview = document.getElementById("import-preview");
const importProgress = document.getElementById("import-progress");
const btnAnalizar = document.getElementById("import-analizar");
const btnConfirmar = document.getElementById("import-confirmar");
let parsedImportRows = null;

document.getElementById("open-import-excel").addEventListener("click", () => {
  importFile.value = "";
  importPreview.style.display = "none";
  importProgress.style.display = "none";
  btnAnalizar.style.display = "inline-block";
  btnConfirmar.style.display = "none";
  parsedImportRows = null;
  importModalBg.classList.add("active");
});
document.getElementById("import-cancel").addEventListener("click", () => importModalBg.classList.remove("active"));
importModalBg.addEventListener("click", (e) => { if (e.target === importModalBg) importModalBg.classList.remove("active"); });

// Normaliza encabezados: quita tildes, mayúsculas, espacios extra
function normalizarHeader(h) {
  return String(h || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .trim().toUpperCase().replace(/\s+/g, " ");
}

btnAnalizar.addEventListener("click", () => {
  const file = importFile.files[0];
  if (!file) { showToast("Selecciona un archivo primero"); return; }
  btnAnalizar.disabled = true;
  btnAnalizar.textContent = "Leyendo...";

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const wb = window.XLSX.read(e.target.result, { type: "array" });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = window.XLSX.utils.sheet_to_json(sheet, { defval: "" });

      const skuExistente = new Map(allProducts.filter(p => p.sku).map(p => [String(p.sku).trim().toUpperCase(), p.id]));
      let nuevos = 0, actualizados = 0, invalidos = 0;
      const stockInicial = Number(importStockInicial.value) || 0;
      parsedImportRows = [];

      rows.forEach(row => {
        const norm = {};
        Object.keys(row).forEach(k => norm[normalizarHeader(k)] = row[k]);

        const codigo = String(norm["CODIGO"] ?? "").trim();
        const nombre = String(norm["DESCRIPCION"] ?? "").trim();
        if (!nombre) { invalidos++; return; }

        const marca = String(norm["MARCA"] ?? "").trim();
        const categoria = String(norm["CATEGORIA"] ?? "").trim();
        const costo = Number(norm["PRECIO COMPRA"]) || 0;
        const precioReferencia = Number(norm["PRECIO REFERENCIA"]) || 0;
        const precio = Number(norm["PRECIO VENTA"]) || 0;
        const codigoBarras = String(norm["CODIGO BARRAS"] ?? norm["CODIGOBARRAS"] ?? norm["BARCODE"] ?? "").trim();
        const minimoRaw = norm["STOCK MINIMO"];
        const stockRaw = norm["STOCK ACTUAL"] ?? norm["STOCK"];
        const minimo = minimoRaw !== undefined && minimoRaw !== "" ? Number(minimoRaw) : 5;
        const stockDelArchivo = stockRaw !== undefined && stockRaw !== "" ? Number(stockRaw) : null;

        const existingId = codigo ? skuExistente.get(codigo.toUpperCase()) : null;
        if (existingId) actualizados++; else nuevos++;

        parsedImportRows.push({
          existingId, sku: codigo, nombre, marca, categoria, costo, precioReferencia, precio, minimo, codigoBarras,
          stockInicial: stockDelArchivo !== null ? stockDelArchivo : stockInicial
        });
      });

      importPreview.style.display = "block";
      importPreview.innerHTML = `
        <b>${rows.length}</b> filas leídas del archivo.<br>
        🟢 <b>${nuevos}</b> productos nuevos se crearán (stock inicial: ${stockInicial}).<br>
        🟡 <b>${actualizados}</b> productos existentes se actualizarán (por código).<br>
        ${invalidos ? `🔴 <b>${invalidos}</b> filas se omiten por no tener descripción.` : ""}
      `;
      btnAnalizar.style.display = "none";
      btnConfirmar.style.display = "inline-block";
    } catch (err) {
      console.error(err);
      showToast("No se pudo leer el archivo: " + err.message);
    } finally {
      btnAnalizar.disabled = false;
      btnAnalizar.textContent = "Analizar archivo";
    }
  };
  reader.readAsArrayBuffer(file);
});

btnConfirmar.addEventListener("click", async () => {
  if (!parsedImportRows || !parsedImportRows.length) return;
  btnConfirmar.disabled = true;
  btnConfirmar.textContent = "Importando...";
  importProgress.style.display = "block";

  const CHUNK = 400;
  let hechos = 0;
  try {
    for (let i = 0; i < parsedImportRows.length; i += CHUNK) {
      const chunk = parsedImportRows.slice(i, i + CHUNK);
      const batch = writeBatch(db);
      chunk.forEach(r => {
        if (r.existingId) {
          batch.update(doc(db, "productos", r.existingId), {
            nombre: r.nombre, sku: r.sku, marca: r.marca, categoria: r.categoria,
            costo: r.costo, precioReferencia: r.precioReferencia, precio: r.precio,
            minimo: r.minimo, codigoBarras: r.codigoBarras, actualizadoEn: serverTimestamp()
          });
        } else {
          batch.set(doc(collection(db, "productos")), {
            nombre: r.nombre, sku: r.sku, marca: r.marca, categoria: r.categoria,
            costo: r.costo, precioReferencia: r.precioReferencia, precio: r.precio,
            stock: r.stockInicial, minimo: r.minimo, codigoBarras: r.codigoBarras,
            creadoEn: serverTimestamp()
          });
        }
      });
      await batch.commit();
      hechos += chunk.length;
      importProgress.textContent = `Importando... ${hechos} / ${parsedImportRows.length}`;
    }
    showToast(`Importación completa: ${hechos} productos procesados`);
    importModalBg.classList.remove("active");
  } catch (err) {
    console.error(err);
    showToast("Error durante la importación: " + err.message);
  } finally {
    btnConfirmar.disabled = false;
    btnConfirmar.textContent = "Confirmar importación";
  }
});

// ---------------- Escáner OCR (Tesseract.js) ----------------
// Palabras que suelen aparecer junto al código en las etiquetas y deben ignorarse
const OCR_IGNORE_WORDS = [
  'NUEVO','NEW','OFERTA','DESCUENTO','EXCELENTE','EXC','IMPORTADO','IMPORT',
  'PROMO','PROMOCION','CALIDAD','GARANTIA','ORIGINAL','SALE','STOCK','PRECIO',
  'FERRETERIA','BOLIVIA','MARCA','MODELO','PROD','PRODUCTO'
];

// Dos modos de escaneo: numérico puro (más preciso para códigos como 12399)
// y alfanumérico (2-4 letras + 2-5 números, guion opcional, ej: HNV3445)
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

// El recuadro punteado en pantalla (#ocr-guide) está definido en porcentajes
// del contenedor visible, pero el <video> se muestra con object-fit:cover
// (recorta y escala la imagen nativa de la cámara). Esta función calcula
// qué parte del video nativo es la que realmente se ve, y recién ahí aplica
// los porcentajes del recuadro.
// IMPORTANTE: deben coincidir con #ocr-guide en el CSS.
const GUIDE_BOX = { left: 0.15, right: 0.15, top: 0.35, bottom: 0.35 };

let ocrWorker = null;
let ocrStream = null;
let ocrTimer = null;
let ocrBusy = false;
let ocrActive = false;
let ocrPaused = false;
let ocrStarting = false;
let scannerContext = "general";

const OCR_INTERVAL_MS = 600;

function findProductByCodigo(codigo) {
  if (!codigo) return null;
  const c = String(codigo).trim().toUpperCase();
  return allProducts.find(p => (p.sku || "").trim().toUpperCase() === c) || null;
}

function cleanOcrToken(raw) {
  return raw.toUpperCase().replace(/[^A-Z0-9-]/g, '').trim();
}

function extractCandidateCodes(text) {
  if (!text) return [];
  const pattern = OCR_MODES[scanCodeMode].pattern;
  const tokens = text.split(/[\s\n\r,;:|]+/).map(cleanOcrToken).filter(Boolean);
  const seen = new Set();
  const candidates = [];
  tokens.forEach(tok => {
    if (seen.has(tok)) return;
    seen.add(tok);
    if (OCR_IGNORE_WORDS.includes(tok)) return;
    if (pattern.test(tok)) candidates.push(tok);
  });
  return candidates;
}

function pickBestCandidate(candidates) {
  if (candidates.length === 0) return null;
  const existing = candidates.find(c => findProductByCodigo(c));
  if (existing) return existing;
  return candidates[0];
}

// Normaliza confusiones típicas de OCR entre letras y números parecidos
// (O/0, I/1, S/5, B/8, Z/2, G/6) para comparar contra códigos guardados
// aunque el OCR haya leído mal algún carácter.
function normalizeForFuzzyMatch(str) {
  return String(str || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    .replace(/O/g, '0').replace(/I/g, '1').replace(/S/g, '5')
    .replace(/B/g, '8').replace(/Z/g, '2').replace(/G/g, '6');
}

function findProductoFuzzy(token) {
  if (!token || token.length < 3) return null;
  const norm = normalizeForFuzzyMatch(token);
  return allProducts.find(p => normalizeForFuzzyMatch(p.sku || '') === norm) || null;
}

function resolveScannedText(text) {
  const candidates = extractCandidateCodes(text);
  const exactExisting = candidates.find(c => findProductByCodigo(c));
  if (exactExisting) return exactExisting;

  if (scanCodeMode === 'alfanumerico') {
    const tokens = String(text || '').split(/[\s\n\r,;:|]+/).map(cleanOcrToken).filter(Boolean);
    for (const tok of tokens) {
      if (OCR_IGNORE_WORDS.includes(tok)) continue;
      const fuzzyMatch = findProductoFuzzy(tok);
      if (fuzzyMatch) return fuzzyMatch.codigo;
    }
  }

  return candidates[0] || null;
}

function setOcrStatus(msg) {
  const el = document.getElementById('ocrStatus');
  if (el) el.textContent = msg;
}

function getGuideBoxCropRect(videoEl, box) {
  box = box || GUIDE_BOX;
  const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
  const containerW = videoEl.clientWidth || vw;
  const containerH = videoEl.clientHeight || vh;

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

function preprocessCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = imgData.data;
  const n = canvas.width * canvas.height;

  const gray = new Uint8ClampedArray(n);
  let min = 255, max = 0;
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    gray[j] = g;
    if (g < min) min = g;
    if (g > max) max = g;
  }

  const range = Math.max(max - min, 1);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) {
    const stretched = ((gray[j] - min) / range) * 255;
    d[i] = d[i + 1] = d[i + 2] = stretched;
  }
  ctx.putImageData(imgData, 0, 0);
}

async function startOcrScanner() {
  if (ocrActive || ocrStarting) return;
  ocrStarting = true;

  if (typeof Tesseract === 'undefined') {
    setOcrStatus('No se pudo cargar Tesseract.js. Verifica tu conexión a internet o usa la búsqueda manual.');
    ocrStarting = false;
    return;
  }

  const videoEl = document.getElementById('ocrVideo');

  try {
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
  } catch (err) {
    console.warn(err);
    setOcrStatus('No se pudo acceder a la cámara. Verifica los permisos del navegador o usa la búsqueda manual.');
    ocrStarting = false;
    return;
  }

  try {
    setOcrStatus('Preparando el lector de texto...');
    ocrWorker = await Tesseract.createWorker('eng');
    await ocrWorker.setParameters({
      tessedit_char_whitelist: OCR_MODES[scanCodeMode].whitelist,
      tessedit_pageseg_mode: '6',
      preserve_interword_spaces: '1'
    });
  } catch (err) {
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

function scheduleNextOcrCapture() {
  if (!ocrActive || ocrPaused) return;
  ocrTimer = setTimeout(runOcrCapture, OCR_INTERVAL_MS);
}

async function runOcrCapture() {
  if (!ocrActive || ocrBusy || ocrPaused) return;
  const videoEl = document.getElementById('ocrVideo');
  const canvasEl = document.getElementById('ocrCanvas');
  if (!videoEl || !videoEl.videoWidth) { scheduleNextOcrCapture(); return; }

  ocrBusy = true;
  try {
    const crop = getGuideBoxCropRect(videoEl);
    const scale = 2;
    canvasEl.width = crop.w * scale;
    canvasEl.height = crop.h * scale;
    const ctx = canvasEl.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(videoEl, crop.x, crop.y, crop.w, crop.h, 0, 0, canvasEl.width, canvasEl.height);
    preprocessCanvas(canvasEl);

    setOcrStatus('🔎 Analizando etiqueta...');
    const { data: { text } } = await ocrWorker.recognize(canvasEl);
    if (ocrPaused) return;
    const best = resolveScannedText(text);

    if (best) {
      const now = Date.now();
      if (!(window.__lastOcrCode === best && now - (window.__lastOcrTime || 0) < 3000)) {
        window.__lastOcrCode = best;
        window.__lastOcrTime = now;
        onCodeScanned(best);
      }
      if (ocrActive) setOcrStatus('✅ Código detectado: ' + best);
    } else if (ocrActive) {
      const raw = String(text || '').replace(/\s+/g, ' ').trim();
      if (raw) {
        setOcrStatus('🔎 Leyendo: "' + raw.slice(0, 28) + '" — buscando código...');
      } else {
        setOcrStatus('🔎 Buscando código... (acerca más la etiqueta o mejora la luz)');
      }
    }
  } catch (err) {
    console.warn('Error de OCR', err);
  } finally {
    ocrBusy = false;
    scheduleNextOcrCapture();
  }
}

async function captureShot() {
  if (!ocrActive || !ocrWorker) return;
  const videoEl = document.getElementById('ocrVideo');
  const canvasEl = document.getElementById('ocrCanvas');
  const frozenImg = document.getElementById('ocrFrozenImg');
  if (!videoEl || !videoEl.videoWidth) return;

  ocrPaused = true;
  if (ocrTimer) { clearTimeout(ocrTimer); ocrTimer = null; }

  const crop = getGuideBoxCropRect(videoEl);
  const scale = 2.2;
  canvasEl.width = crop.w * scale;
  canvasEl.height = crop.h * scale;
  const ctx = canvasEl.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(videoEl, crop.x, crop.y, crop.w, crop.h, 0, 0, canvasEl.width, canvasEl.height);

  frozenImg.src = canvasEl.toDataURL('image/jpeg', 0.85);
  frozenImg.classList.add('visible');
  document.getElementById('btnCaptureShot').style.display = 'none';
  document.getElementById('btnResumeLive').style.display = '';
  setOcrStatus('📸 Foto capturada. Analizando...');

  ocrBusy = true;
  try {
    preprocessCanvas(canvasEl);
    const { data: { text } } = await ocrWorker.recognize(canvasEl);
    const best = resolveScannedText(text);

    if (best) {
      onCodeScanned(best);
      setOcrStatus('✅ Código detectado: ' + best);
    } else {
      const raw = String(text || '').replace(/\s+/g, ' ').trim();
      setOcrStatus(raw
        ? '⚠️ No coincide ningún código. Se leyó: "' + raw.slice(0, 28) + '"'
        : '⚠️ No se detectó texto legible. Intenta de nuevo o cambia de modo (numérico/alfanumérico).');
    }
  } catch (err) {
    console.warn('Error al capturar foto', err);
    setOcrStatus('No se pudo analizar la foto. Intenta de nuevo.');
  } finally {
    ocrBusy = false;
  }
}

function resumeLiveScan() {
  ocrPaused = false;
  const frozenImg = document.getElementById('ocrFrozenImg');
  frozenImg.classList.remove('visible');
  frozenImg.removeAttribute('src');
  document.getElementById('btnCaptureShot').style.display = '';
  document.getElementById('btnResumeLive').style.display = 'none';
  if (ocrActive) {
    setOcrStatus('🔎 Buscando código...');
    scheduleNextOcrCapture();
  }
}

function stopOcrScanner() {
  ocrActive = false;
  ocrStarting = false;
  ocrPaused = false;
  if (ocrTimer) { clearTimeout(ocrTimer); ocrTimer = null; }
  if (ocrStream) {
    ocrStream.getTracks().forEach(t => t.stop());
    ocrStream = null;
  }
  const videoEl = document.getElementById('ocrVideo');
  if (videoEl) videoEl.srcObject = null;
  if (ocrWorker) {
    const w = ocrWorker;
    ocrWorker = null;
    w.terminate().catch(() => {});
  }
  const frozenImg = document.getElementById('ocrFrozenImg');
  if (frozenImg) { frozenImg.classList.remove('visible'); frozenImg.removeAttribute('src'); }
  const btnCapture = document.getElementById('btnCaptureShot');
  const btnResume = document.getElementById('btnResumeLive');
  if (btnCapture) btnCapture.style.display = '';
  if (btnResume) btnResume.style.display = 'none';
  setOcrStatus('Iniciando cámara...');
}

async function setScanCodeMode(mode) {
  if (!OCR_MODES[mode] || mode === scanCodeMode) return;
  scanCodeMode = mode;
  document.getElementById("scan-mode-numeric").classList.toggle("active", mode === "numerico");
  document.getElementById("scan-mode-alpha").classList.toggle("active", mode === "alfanumerico");
  if (ocrWorker) {
    try {
      await ocrWorker.setParameters({ tessedit_char_whitelist: OCR_MODES[mode].whitelist });
    } catch (err) { console.warn(err); }
  }
}

function openScanner(context) {
  scannerContext = context || "general";
  const resultEl = document.getElementById("scanner-result");
  resultEl.style.display = "none";
  resultEl.innerHTML = "";
  document.getElementById("scan-manual-input").value = "";
  document.getElementById("scanner-modal-bg").classList.add("active");
  startOcrScanner();
}

document.getElementById("global-scan-btn").addEventListener("click", () => openScanner("general"));
document.getElementById("open-scanner-btn").addEventListener("click", () => openScanner("ventas"));
document.getElementById("scan-mode-numeric").addEventListener("click", () => setScanCodeMode("numerico"));
document.getElementById("scan-mode-alpha").addEventListener("click", () => setScanCodeMode("alfanumerico"));

document.getElementById("scan-manual-go").addEventListener("click", () => {
  const val = document.getElementById("scan-manual-input").value.trim();
  if (val) onCodeScanned(val);
});
document.getElementById("scan-manual-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const val = e.target.value.trim();
    if (val) onCodeScanned(val);
  }
});
document.getElementById("btnCaptureShot").addEventListener("click", captureShot);
document.getElementById("btnResumeLive").addEventListener("click", resumeLiveScan);

async function stopScanner() {
  stopOcrScanner();
  document.getElementById("scanner-modal-bg").classList.remove("active");
}
document.getElementById("scanner-cancel").addEventListener("click", stopScanner);
document.getElementById("scanner-modal-bg").addEventListener("click", (e) => {
  if (e.target === document.getElementById("scanner-modal-bg")) stopScanner();
});

function onCodeScanned(codigo) {
  codigo = String(codigo).trim();
  if (!codigo) return;
  logScanHistory(codigo);
  const product = findProductByCodigo(codigo);

  if (scannerContext === "inventario") {
    stopScanner();
    openInventoryModal(product, codigo);
    return;
  }

  if (scannerContext === "ventas") {
    if (product) {
      stopScanner();
      addToCart(product);
      showToast("Agregado a la venta: " + product.nombre);
      return;
    }
    renderScanResult(codigo, null);
    return;
  }

  renderScanResult(codigo, product);
}

function renderScanResult(codigo, product) {
  const el = document.getElementById("scanner-result");
  el.style.display = "block";
  if (product) {
    const stock = Number(product.stock) || 0;
    const minimo = Number(product.minimo) || 0;
    let badge = `<span class="badge ok">OK</span>`;
    if (stock === 0) badge = `<span class="badge bad">Sin stock</span>`;
    else if (stock <= minimo) badge = `<span class="badge warn">Stock bajo</span>`;

    el.innerHTML = `
      <div class="scan-result-card">
        <div class="rc-title">✔ Producto encontrado</div>
        <dl>
          <dt>Código</dt><dd>${escapeHtml(product.sku || "—")}</dd>
          <dt>Descripción</dt><dd style="font-family:inherit;">${escapeHtml(product.nombre)}</dd>
          <dt>Marca</dt><dd style="font-family:inherit;">${escapeHtml(product.marca || "—")}</dd>
          <dt>Categoría</dt><dd style="font-family:inherit;">${escapeHtml(product.categoria || "—")}</dd>
          <dt>Cód. barras</dt><dd>${escapeHtml(product.codigoBarras || "—")}</dd>
          <dt>Precio compra</dt><dd>Bs ${(Number(product.costo) || 0).toFixed(2)}</dd>
          <dt>Precio referencia</dt><dd>Bs ${(Number(product.precioReferencia) || 0).toFixed(2)}</dd>
          <dt>Precio venta</dt><dd>Bs ${(Number(product.precio) || 0).toFixed(2)}</dd>
          <dt>Stock mínimo</dt><dd>${minimo}</dd>
          <dt>Stock actual</dt><dd>${stock} ${badge}</dd>
        </dl>
      </div>
      <div class="scan-actions">
        <button type="button" class="btn btn-primary" id="scan-act-venta">🛒 Registrar venta</button>
        <button type="button" class="btn btn-secondary" id="scan-act-compra">📦 Registrar compra</button>
        <button type="button" class="btn btn-secondary" id="scan-act-inventario">📦 Registrar cantidad de inventario</button>
        <button type="button" class="btn btn-secondary" id="scan-act-editar">✎ Ver / editar información</button>
        <button type="button" class="btn btn-secondary" id="scan-act-otro">🔁 Escanear otro código</button>
      </div>
    `;
    document.getElementById("scan-act-venta").addEventListener("click", () => {
      addToCart(product);
      showToast(`Agregado a la venta: ${product.nombre}`);
      stopScanner();
      switchView("ventas");
    });
    document.getElementById("scan-act-compra").addEventListener("click", () => {
      stopScanner();
      switchView("compras");
      openCompraModal(product.id);
    });
    document.getElementById("scan-act-inventario").addEventListener("click", () => {
      stopScanner();
      openInventoryModal(product, null);
    });
    document.getElementById("scan-act-editar").addEventListener("click", () => {
      stopScanner();
      switchView("productos");
      openProductModal(product);
    });
  } else {
    el.innerHTML = `
      <div class="scan-result-card">
        <div class="rc-title">⚠️ Código no encontrado</div>
        <p style="margin:0 0 6px; font-size:13px; color:var(--ink-soft);">No hay ningún producto con el código:</p>
        <span class="scan-code-pill">${escapeHtml(codigo)}</span>
      </div>
      <div class="scan-actions">
        <button type="button" class="btn btn-primary" id="scan-act-nuevo">+ Nuevo producto con este código</button>
        <button type="button" class="btn btn-secondary" id="scan-act-otro">🔁 Escanear otro código</button>
      </div>
    `;
    document.getElementById("scan-act-nuevo").addEventListener("click", () => {
      stopScanner();
      switchView("productos");
      openProductModal(null, codigo);
    });
  }
  document.getElementById("scan-act-otro").addEventListener("click", () => {
    el.style.display = "none";
    el.innerHTML = "";
  });
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}
