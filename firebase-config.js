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
  apiKey: "AIzaSyDxZsRC2109QZr7ENaFPsNDW0lT9Y1kcZY",
  authDomain: "app-perez-f9e37.firebaseapp.com",
  projectId: "app-perez-f9e37",
  storageBucket: "app-perez-f9e37.firebasestorage.app",
  messagingSenderId: "613161124999",
  appId: "1:613161124999:web:01f8e76daa4559b7a2a422"
};
