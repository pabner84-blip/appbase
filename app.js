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
  } else {
    currentUser = null;
    appShell.classList.remove("active");
    loginScreen.style.display = "flex";
    if (unsubProducts) { unsubProducts(); unsubProducts = null; }
    if (unsubCompras) { unsubCompras(); unsubCompras = null; }
    if (unsubTurno) { unsubTurno(); unsubTurno = null; }
    if (unsubMovimientos) { unsubMovimientos(); unsubMovimientos = null; }
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
navItems.forEach(item => {
  item.addEventListener("click", () => {
    if (item.classList.contains("disabled")) return;
    navItems.forEach(n => n.classList.remove("active"));
    item.classList.add("active");
    document.querySelectorAll("main > section").forEach(s => s.style.display = "none");
    document.getElementById("view-" + item.dataset.view).style.display = "block";
  });
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

function renderProducts() {
  const term = searchInput.value.trim().toLowerCase();
  const list = allProducts.filter(p =>
    !term || p.nombre.toLowerCase().includes(term) || (p.sku || "").toLowerCase().includes(term)
  );

  tbody.innerHTML = "";
  emptyState.style.display = list.length ? "none" : "block";

  let bajo = 0, cero = 0, valor = 0;

  list.forEach(p => {
    const stock = Number(p.stock) || 0;
    const minimo = Number(p.minimo) || 0;
    const precio = Number(p.precio) || 0;
    const costo = Number(p.costo) || 0;
    valor += stock * costo;
    if (stock === 0) cero++;
    else if (stock <= minimo) bajo++;

    let pct = minimo > 0 ? Math.min(100, (stock / (minimo * 2)) * 100) : (stock > 0 ? 100 : 0);
    let color = "var(--green)";
    if (stock === 0) { color = "var(--red)"; pct = 100; }
    else if (stock <= minimo) { color = "var(--yellow)"; }

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <div style="font-weight:600;">${escapeHtml(p.nombre)}</div>
        ${p.sku ? `<div class="sku">${escapeHtml(p.sku)}</div>` : ""}
      </td>
      <td class="num">Bs ${precio.toFixed(2)}</td>
      <td class="num">Bs ${costo.toFixed(2)}</td>
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
}

searchInput.addEventListener("input", renderProducts);

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
const fPrecio = document.getElementById("p-precio");
const fCosto = document.getElementById("p-costo");
const fStock = document.getElementById("p-stock");
const fMinimo = document.getElementById("p-minimo");

document.getElementById("open-add-product").addEventListener("click", () => openProductModal(null));
document.getElementById("product-cancel").addEventListener("click", closeProductModal);
modalBg.addEventListener("click", (e) => { if (e.target === modalBg) closeProductModal(); });

function openProductModal(product) {
  productForm.reset();
  if (product) {
    modalTitle.textContent = "Editar producto";
    fId.value = product.id;
    fNombre.value = product.nombre || "";
    fSku.value = product.sku || "";
    fPrecio.value = product.precio ?? "";
    fCosto.value = product.costo ?? "";
    fStock.value = product.stock ?? 0;
    fMinimo.value = product.minimo ?? 5;
  } else {
    modalTitle.textContent = "Nuevo producto";
    fId.value = "";
    fMinimo.value = 5;
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
    precio: Number(fPrecio.value),
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
const cActualizarCosto = document.getElementById("c-actualizar-costo");

document.getElementById("open-add-compra").addEventListener("click", () => {
  if (!allProducts.length) {
    showToast("Primero agrega al menos un producto en la sección Productos");
    return;
  }
  compraForm.reset();
  cActualizarCosto.checked = true;
  cProducto.innerHTML = allProducts.map(p => `<option value="${p.id}">${escapeHtml(p.nombre)}</option>`).join("");
  compraModalBg.classList.add("active");
});
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

  try {
    // 1. Registrar la compra en el historial
    await addDoc(collection(db, "compras"), {
      productoId,
      productoNombre: producto.nombre,
      proveedor: cProveedor.value.trim(),
      cantidad,
      costoUnitario,
      fecha: serverTimestamp(),
      registradoPor: currentUser?.email || "—"
    });

    // 2. Sumar el stock del producto (y opcionalmente actualizar su costo)
    const updateData = { stock: increment(cantidad) };
    if (cActualizarCosto.checked) updateData.costo = costoUnitario;
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
    cart.push({ productoId: product.id, nombre: product.nombre, precio: Number(product.precio), cantidad: 1, stockDisponible: Number(product.stock) });
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
      <td class="num">Bs ${item.precio.toFixed(2)}</td>
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
  if (qtyIdx !== undefined) {
    let val = Number(e.target.value);
    const item = cart[qtyIdx];
    if (val > item.stockDisponible) { val = item.stockDisponible; showToast("Stock máximo disponible: " + val); }
    if (val < 1) val = 1;
    item.cantidad = val;
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

  try {
    await addDoc(collection(db, "ventas"), {
      items: cart.map(i => ({ productoId: i.productoId, nombre: i.nombre, precio: i.precio, cantidad: i.cantidad })),
      total,
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

// ---------------- Escáner de código de barras ----------------
let html5QrCode = null;
const scannerModalBg = document.getElementById("scanner-modal-bg");

document.getElementById("open-scanner-btn").addEventListener("click", async () => {
  scannerModalBg.classList.add("active");
  try {
    html5QrCode = new Html5Qrcode("scanner-reader");
    await html5QrCode.start(
      { facingMode: "environment" },
      { fps: 10, qrbox: 220 },
      (decodedText) => {
        const match = allProducts.find(p => (p.sku || "").toLowerCase() === decodedText.toLowerCase());
        if (match) {
          addToCart(match);
          showToast(`Agregado: ${match.nombre}`);
        } else {
          showToast("Código no encontrado en el catálogo: " + decodedText);
        }
      },
      () => {}
    );
  } catch (err) {
    showToast("No se pudo abrir la cámara: " + err.message);
  }
});

async function stopScanner() {
  if (html5QrCode) {
    try { await html5QrCode.stop(); html5QrCode.clear(); } catch (e) {}
    html5QrCode = null;
  }
  scannerModalBg.classList.remove("active");
}
document.getElementById("scanner-cancel").addEventListener("click", stopScanner);
scannerModalBg.addEventListener("click", (e) => { if (e.target === scannerModalBg) stopScanner(); });

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
        const precio = Number(norm["PRECIO VENTA"]) || 0;

        const existingId = codigo ? skuExistente.get(codigo.toUpperCase()) : null;
        if (existingId) actualizados++; else nuevos++;

        parsedImportRows.push({ existingId, sku: codigo, nombre, marca, categoria, costo, precio, stockInicial });
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
            costo: r.costo, precio: r.precio, actualizadoEn: serverTimestamp()
          });
        } else {
          batch.set(doc(collection(db, "productos")), {
            nombre: r.nombre, sku: r.sku, marca: r.marca, categoria: r.categoria,
            costo: r.costo, precio: r.precio, stock: r.stockInicial, minimo: 5,
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
