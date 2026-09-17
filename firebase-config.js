/* =========================================================================
   CONFIGURACIÓN DE FIREBASE
   =========================================================================
   Pega aquí los datos de TU proyecto de Firebase para que la app sincronice
   productos, categorías, ventas e inventario entre todos los celulares.

   Cómo conseguirlos:
   1. Entra a https://console.firebase.google.com y crea un proyecto (gratis).
   2. Dentro del proyecto: ⚙️ Configuración del proyecto → pestaña "General"
      → sección "Tus apps" → clic en el ícono </> (agregar app web).
   3. Te va a mostrar un bloque como el de abajo (firebaseConfig): copia esos
      valores y pégalos aquí, reemplazando las comillas vacías.
   4. Activa Firestore Database: menú lateral → Compilación → Firestore
      Database → Crear base de datos → modo de prueba (para empezar rápido).

   Si dejas todo esto vacío (como está ahora), la app funciona igual, pero
   solo guarda los datos en este celular, sin sincronizar con otros.
   ========================================================================= */

const firebaseConfig = {
  apiKey: "AIzaSyDs9j2aVyKOe4BwJfcSOCKN16he8kit8WU",
  authDomain: "app-perez-2.firebaseapp.com",
  projectId: "app-perez-2",
  storageBucket: "app-perez-2.firebasestorage.app",
  messagingSenderId: "635214212777",
  appId: "1:635214212777:web:01568a1f9497183a2f03b8"
};
