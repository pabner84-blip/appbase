/* =========================================================================
   CONFIGURACIÓN DE FIREBASE — DOS PROYECTOS SEPARADOS
   =========================================================================
   La app usa DOS proyectos de Firebase distintos para que los modos nunca
   se mezclen (un fallo de sincronización de uno NO puede tocar al otro):

     • firebaseConfigManual    -> app-perez-2
       Herramientas MANUALES (catálogo, ventas, gastos, finanzas).

     • firebaseConfigElectrico -> app-ferreteria-bd73f
       Herramientas ELÉCTRICAS (catálogo, ventas, gastos, finanzas) + todos
       los datos del MODO INVITADO (ventas, gastos, finanzas y contraseña).

   El modo INVITADO lee el catálogo de AMBOS proyectos (uno de cada) y los
   junta en pantalla, pero sus ventas/gastos se guardan en app-ferreteria-bd73f.

   Cómo conseguir los datos de un proyecto nuevo:
   1. Entra a https://console.firebase.google.com y crea un proyecto (gratis).
   2. Dentro del proyecto: ⚙️ Configuración del proyecto → pestaña "General"
      → sección "Tus apps" → clic en el ícono </> (agregar app web).
   3. Copia el bloque firebaseConfig y pégalo abajo reemplazando el que toque.
   4. Activa Firestore Database en CADA proyecto: menú lateral → Firestore
      Database → Crear base de datos → modo de prueba (para empezar rápido).
   ========================================================================= */

const firebaseConfigManual = {
  apiKey: "AIzaSyDs9j2aVyKOe4BwJfcSOCKN16he8kit8WU",
  authDomain: "app-perez-2.firebaseapp.com",
  projectId: "app-perez-2",
  storageBucket: "app-perez-2.firebasestorage.app",
  messagingSenderId: "635214212777",
  appId: "1:635214212777:web:01568a1f9497183a2f03b8"
};

const firebaseConfigElectrico = {
  apiKey: "AIzaSyBzl4dJy3ofDNkFV2WNy3If2crpZZScqsk",
  authDomain: "app-ferreteria-bd73f.firebaseapp.com",
  projectId: "app-ferreteria-bd73f",
  storageBucket: "app-ferreteria-bd73f.firebasestorage.app",
  messagingSenderId: "358852202919",
  appId: "1:358852202919:web:8f2a3fc62be0ca1d232682"
};
