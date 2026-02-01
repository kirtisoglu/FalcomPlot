
import http.server
import socketserver
import os
import threading
import time
import webbrowser
import sys
from functools import partial

# Constants
PORT = 8080 # Default port, can be dynamic
package_dir = os.path.dirname(__file__)
WEB_ASSETS_DIR = os.path.join(package_dir, "web_assets")

class FalcomHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, data_dir=None, **kwargs):
        self.data_dir = data_dir
        super().__init__(*args, **kwargs)

    def translate_path(self, path):
        # Decode path
        path = super().translate_path(path)
        
        # Get the relative path from the current working directory (which super() uses)
        # However, super().translate_path joins with os.getcwd().
        # We need to manually handle the routing.
        
        # Better approach: parse the request path
        # If it starts with /data, map to self.data_dir
        # Else map to WEB_ASSETS_DIR
        
        clean_path = self.path.split('?',1)[0]
        clean_path = clean_path.split('#',1)[0]
        
        if clean_path.startswith('/data/'):
            # It's a data request
            # Remove '/data' prefix
            rel_path = clean_path[6:] # len('/data/') == 6? No, len('/data')=5. 
            # If path is /data/foo, we want /foo relative to data_dir
            if rel_path.startswith('/'):
                rel_path = rel_path[1:]
            
            # Use data_dir
            return os.path.join(self.data_dir, rel_path)
        else:
            # It's a web asset request
            # We want to serve from WEB_ASSETS_DIR
            # We need to compute the path relative to WEB_ASSETS_DIR
            
            # But wait, translate_path is called by do_GET -> send_head. 
            # SimpleHTTPRequestHandler.translate_path joins path with cwd.
            # We can override log_message to silence logs if needed.
            
            # Let's just bypass the super().translate_path logic or manipulate it.
            # Re-implementing simplified logic:
            
            path = clean_path
            path = path.lstrip('/')
            
            if not path or path == "index.html":
                return os.path.join(WEB_ASSETS_DIR, "index.html")
                
            return os.path.join(WEB_ASSETS_DIR, path)

    def log_message(self, format, *args):
        # Optional: override to silence logging
        pass

def start_server(data_dir, port=0, open_browser=True):
    """
    Start the serving on a separate thread.
    """
    if not os.path.isdir(data_dir):
        print(f"Error: Data directory '{data_dir}' not found.")
        return

    # Use partial to pass data_dir to the handler
    handler_class = partial(FalcomHandler, data_dir=os.path.abspath(data_dir))
    
    # Port 0 lets the OS pick a free port
    with socketserver.ThreadingTCPServer(("", port), handler_class) as httpd:
        actual_port = httpd.server_address[1]
        url = f"http://localhost:{actual_port}"
        print(f"Serving FalcomPlot at {url}")
        print(f"Data source: {data_dir}")
        print("Press Ctrl+C to stop.")

        if open_browser:
            threading.Timer(1.0, lambda: webbrowser.open(url)).start()
        
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nStopping server...")
            httpd.shutdown()
