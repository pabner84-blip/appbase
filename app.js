// ============================================================
// FERRETERÍA · App de inventario — Fase 1: Login + Productos/Stock
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore, collection, doc, setDoc, addDoc, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, where, getDoc, serverTimestamp, increment, Timestamp, writeBatch
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

function renderProducts() {
  const term = searchInput.value.trim().toLowerCase();
  const list = allProducts.filter(p =>
    !term || p.nombre.toLowerCase().includes(term) || (p.sku || "").toLowerCase().includes(term) ||
    (p.marca || "").toLowerCase().includes(term) || (p.categoria || "").toLowerCase().includes(term)
  );

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
}

searchInput.addEventListener("input", renderProducts);

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
    marca: fMarca.value.trim(),
    categoria: fCategoria.value.trim(),
    precio: Number(fPrecio.value),
    precioReferencia: Number(fRefPrecio.value) || 0,
    costo: Number(fCosto.value),
    stock: Number(fStock.value),
    minimo: Number(fMinimo.value),
    actualizadoEn: serverTimestamp()
  };

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
let unsubCompras = null;
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
let unsubTurno = null;
let unsubMovimientos = null;
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
  const tbody = document.getElementById("movimientos-tbody");
  const empty = document.getElementById("movimientos-empty");
  tbody.innerHTML = "";

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
    tbody.appendChild(tr);
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
let unsubVentas = null;
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
let unsubGastos = null;
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

// ---------------- Escáner de código de barras ----------------
let html5QrCode = null;
const scannerModalBg = document.getElementById("scanner-modal-bg");
const scannerModeSelect = document.getElementById("scanner-mode-select");
const scannerCameraWrap = document.getElementById("scanner-camera-wrap");
const scannerResult = document.getElementById("scanner-result");

// Formatos típicos de código numérico (EAN/UPC) vs alfanumérico (CODE128/CODE39/QR)
const FORMATS_NUMERICO = ["EAN_13", "EAN_8", "UPC_A", "UPC_E", "ITF", "CODABAR"];
const FORMATS_ALFANUMERICO = ["CODE_128", "CODE_39", "CODE_93", "QR_CODE", "DATA_MATRIX"];

function resolveFormats(names) {
  // Html5QrcodeSupportedFormats es un enum expuesto globalmente por la librería
  if (!window.Html5QrcodeSupportedFormats) return undefined;
  return names
    .map(n => window.Html5QrcodeSupportedFormats[n])
    .filter(f => f !== undefined);
}

function openScanner() {
  scannerModeSelect.style.display = "block";
  scannerCameraWrap.style.display = "none";
  scannerResult.style.display = "none";
  scannerModalBg.classList.add("active");
}
document.getElementById("global-scan-btn").addEventListener("click", openScanner);
document.getElementById("open-scanner-btn").addEventListener("click", openScanner);

async function startScan(formats) {
  scannerModeSelect.style.display = "none";
  scannerResult.style.display = "none";
  scannerCameraWrap.style.display = "block";
  try {
    const supported = resolveFormats(formats);
    html5QrCode = new Html5Qrcode("scanner-reader", supported ? { formatsToSupport: supported } : undefined);
    await html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: 220 },
      (decodedText) => onCodeScanned(decodedText),
      () => {}
    );
  } catch (err) {
    showToast("No se pudo abrir la cámara: " + err.message);
    scannerModeSelect.style.display = "block";
    scannerCameraWrap.style.display = "none";
  }
}

document.getElementById("scan-mode-numeric").addEventListener("click", () => startScan(FORMATS_NUMERICO));
document.getElementById("scan-mode-alpha").addEventListener("click", () => startScan(FORMATS_ALFANUMERICO));

async function pauseCamera() {
  if (html5QrCode) {
    try { await html5QrCode.stop(); html5QrCode.clear(); } catch (e) {}
    html5QrCode = null;
  }
}

document.getElementById("scanner-back").addEventListener("click", async () => {
  await pauseCamera();
  scannerCameraWrap.style.display = "none";
  scannerModeSelect.style.display = "block";
});

async function stopScanner() {
  await pauseCamera();
  scannerModalBg.classList.remove("active");
}
document.getElementById("scanner-cancel").addEventListener("click", stopScanner);
scannerModalBg.addEventListener("click", (e) => { if (e.target === scannerModalBg) stopScanner(); });

async function onCodeScanned(decodedText) {
  await pauseCamera();
  scannerCameraWrap.style.display = "none";
  const codigo = decodedText.trim();
  const match = allProducts.find(p => (p.sku || "").toLowerCase() === codigo.toLowerCase());
  renderScanResult(codigo, match);
}

function renderScanResult(codigo, product) {
  scannerResult.style.display = "block";
  if (product) {
    const stock = Number(product.stock) || 0;
    const minimo = Number(product.minimo) || 0;
    let badge = `<span class="badge ok">OK</span>`;
    if (stock === 0) badge = `<span class="badge bad">Sin stock</span>`;
    else if (stock <= minimo) badge = `<span class="badge warn">Stock bajo</span>`;

    scannerResult.innerHTML = `
      <div class="scan-result-card">
        <div class="rc-title">✔ Producto encontrado</div>
        <dl>
          <dt>Código</dt><dd>${escapeHtml(product.sku || "—")}</dd>
          <dt>Descripción</dt><dd style="font-family:inherit;">${escapeHtml(product.nombre)}</dd>
          <dt>Marca</dt><dd style="font-family:inherit;">${escapeHtml(product.marca || "—")}</dd>
          <dt>Categoría</dt><dd style="font-family:inherit;">${escapeHtml(product.categoria || "—")}</dd>
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
    document.getElementById("scan-act-editar").addEventListener("click", () => {
      stopScanner();
      switchView("productos");
      openProductModal(product);
    });
  } else {
    scannerResult.innerHTML = `
      <div class="scan-result-card">
        <div class="rc-title">Código no encontrado</div>
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
    scannerResult.style.display = "none";
    scannerModeSelect.style.display = "block";
  });
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
        const minimoRaw = norm["STOCK MINIMO"];
        const stockRaw = norm["STOCK ACTUAL"] ?? norm["STOCK"];
        const minimo = minimoRaw !== undefined && minimoRaw !== "" ? Number(minimoRaw) : 5;
        const stockDelArchivo = stockRaw !== undefined && stockRaw !== "" ? Number(stockRaw) : null;

        const existingId = codigo ? skuExistente.get(codigo.toUpperCase()) : null;
        if (existingId) actualizados++; else nuevos++;

        parsedImportRows.push({
          existingId, sku: codigo, nombre, marca, categoria, costo, precioReferencia, precio, minimo,
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
            minimo: r.minimo, actualizadoEn: serverTimestamp()
          });
        } else {
          batch.set(doc(collection(db, "productos")), {
            nombre: r.nombre, sku: r.sku, marca: r.marca, categoria: r.categoria,
            costo: r.costo, precioReferencia: r.precioReferencia, precio: r.precio,
            stock: r.stockInicial, minimo: r.minimo,
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

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, m => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}
