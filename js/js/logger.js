// Logging and status updates
export class Logger {
    constructor(statusPanel, config) {
        this.statusPanel = statusPanel;
        this.config = config;
        this.statusEl = document.getElementById('status');
        this.debugPanel = document.getElementById('debug-panel');
        this.statusLogPanel = document.getElementById('statusPanel');
    }

    log(msg, type = "info") {
        console.log(`[${type.toUpperCase()}] ${msg}`);

        // Update debug panel if it exists
        if (this.debugPanel) {
            const div = document.createElement('div');
            div.className = `log-${type}`;
            div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
            this.debugPanel.appendChild(div);
            this.debugPanel.scrollTop = this.debugPanel.scrollHeight;
        }

        // Update status log panel if it exists
        if (this.statusLogPanel) {
            const timestamp = new Date().toLocaleTimeString();
            let html = this.statusLogPanel.innerHTML;
            const maxLines = 8;
            const lines = html.split("<br>").slice(-(maxLines - 1));
            const color = type === "error" ? "#c62828" : type === "success" ? "#2e7d32" : "#666";
            this.statusLogPanel.innerHTML = [
                ...lines,
                `<span style="color: ${color}">[${timestamp}] ${msg}</span>`,
            ].join("<br>");
            this.statusLogPanel.scrollTop = this.statusLogPanel.scrollHeight;
        }
    }

    warn(msg) {
        this.log(msg, "warn");
    }

    error(msg) {
        this.log(msg, "error");
    }

    updateStatus(msg, type = "info") {
        if (this.statusEl) {
            this.statusEl.textContent = msg;
            this.statusEl.style.color = type === "error" ? "#d32f2f" :
                type === "success" ? "#388e3c" : "#666";
        }
        this.log(msg, type);
    }
}