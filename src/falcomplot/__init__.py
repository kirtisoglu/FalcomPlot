from .server import start_server
import os

def animate(data_path, port=0, open_browser=True):
    """
    Launches the FalcomPlot visualization.

    Args:
        data_path (str): Path to the directory containing the data (blocks.json, etc.).
        port (int): Port to run the server on. 0 for random free port.
        open_browser (bool): Whether to open the browser automatically.
    """
    if not os.path.exists(data_path):
        raise FileNotFoundError(f"Data path not found: {data_path}")

    start_server(data_path, port=port, open_browser=open_browser)
