then open http://localhost:8000/vindex.html on your browser






project/
 │
├── index.html             # Only loads the canvas and script modules
├── style.css              # Optional if CSS grows large
 │
├── js/
 │   ├── main.js            # App entry point (calls everything)
 │   ├── graphRenderer.js   # Handles static drawing + transform
 │   ├── animation.js       # Step logic, animateRecursiveCut()
 │   ├── infoBox.js         # Updates the info window
 │   └── utils.js           # Optional: shared logic/helpers
