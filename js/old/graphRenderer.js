// 📁 js/graphRenderer.js

let canvas, ctx;
let tooltip;
let transform = { x: 0, y: 0, k: 1, angle: 0 };
let initialTransform = null;
let center = { x: 0, y: 0 };

let nodes = [], links = [], nodesById = {};

export function setGraphData(data) {
    nodes = data.nodes;
    links = data.links;
    nodesById = Object.fromEntries(nodes.map(n => [n.id, n]));
    autoCenterAndScale();
}

export function draw() {
    if (!ctx) return;
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);
    ctx.translate(center.x, center.y);
    ctx.rotate(transform.angle);
    ctx.translate(-center.x, -center.y);

    ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
    ctx.lineWidth = 0.4 / transform.k;
    ctx.beginPath();
    for (let link of links) {
        const s = nodesById[link.source];
        const t = nodesById[link.target];
        if (s && t) {
            ctx.moveTo(s.x, s.y);
            ctx.lineTo(t.x, t.y);
        }
    }
    ctx.stroke();

    for (let node of nodes) {
        ctx.beginPath();
        ctx.fillStyle = "yellow";
        ctx.arc(node.x, node.y, 0.1 / transform.k, 0, 2 * Math.PI);
        ctx.fill();
    }

    ctx.restore();
}

export function drawStep(step) {
    draw();

    ctx.save();
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);
    ctx.translate(center.x, center.y);
    ctx.rotate(transform.angle);
    ctx.translate(-center.x, -center.y);

    ctx.strokeStyle = "yellow";
    ctx.lineWidth = 1 / transform.k;
    ctx.beginPath();
    for (const [source, target] of step.tree.edges) {
        const s = nodesById[source];
        const t = nodesById[target];
        if (s && t) {
            ctx.moveTo(s.x, s.y);
            ctx.lineTo(t.x, t.y);
        }
    }
    ctx.stroke();

    for (const nodeObj of step.cut_nodes) {
        const node = nodesById[nodeObj.node];
        if (node) {
            ctx.beginPath();
            ctx.fillStyle = nodeObj.accepted ? "orange" : "red";
            ctx.arc(node.x, node.y, 2 / transform.k, 0, 2 * Math.PI);
            ctx.fill();
        }
    }

    ctx.restore();
}

function autoCenterAndScale() {
    const xs = nodes.map(n => n.x);
    const ys = nodes.map(n => n.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);

    const graphWidth = maxX - minX;
    const graphHeight = maxY - minY;
    const padding = 40;

    const scaleX = (canvas.width - 2 * padding) / graphWidth;
    const scaleY = (canvas.height - 2 * padding) / graphHeight;
    const scale = Math.min(scaleX, scaleY);

    center = {
        x: (minX + maxX) / 2,
        y: (minY + maxY) / 2
    };

    transform.k = scale;
    transform.x = padding + (canvas.width - scale * (minX + maxX)) / 2;
    transform.y = padding + (canvas.height - scale * (minY + maxY)) / 2;
    transform.angle = 0;

    initialTransform = { ...transform };
}

export function setupCanvasInteractions() {
    canvas = document.getElementById("graphCanvas");
    ctx = canvas.getContext("2d");
    tooltip = document.getElementById("tooltip");

    function resize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
    window.addEventListener("resize", resize);
    resize();

    let isDragging = false, dragStart = null;

    canvas.addEventListener("mousedown", evt => {
        isDragging = true;
        dragStart = { x: evt.clientX, y: evt.clientY };
    });

    canvas.addEventListener("mousemove", evt => {
        if (isDragging) {
            const dx = evt.clientX - dragStart.x;
            const dy = evt.clientY - dragStart.y;
            transform.x += dx;
            transform.y += dy;
            dragStart = { x: evt.clientX, y: evt.clientY };
            draw();
        } else {
            const mouse = getMousePos(evt);
            const node = findNearestNode(mouse);
            if (node) {
                tooltip.style.left = (evt.pageX + 10) + "px";
                tooltip.style.top = (evt.pageY + 10) + "px";
                tooltip.innerHTML = `ID: ${node.id}<br>x: ${node.x.toFixed(2)}, y: ${node.y.toFixed(2)}`;
                tooltip.style.display = "block";
            } else {
                tooltip.style.display = "none";
            }
        }
    });

    canvas.addEventListener("mouseup", () => {
        isDragging = false;
    });

    canvas.addEventListener("wheel", evt => {
        evt.preventDefault();
        const scale = evt.deltaY < 0 ? 1.1 : 0.9;
        const mouse = getMousePos(evt);
        transform.x -= mouse.x * (scale - 1) * transform.k;
        transform.y -= mouse.y * (scale - 1) * transform.k;
        transform.k *= scale;
        draw();
    }, { passive: false });

    window.resetView = () => {
        if (initialTransform) {
            transform = { ...initialTransform };
            draw();
        }
    };

    window.rotateView = (delta) => {
        transform.angle += delta;
        draw();
    };
}

function getMousePos(evt) {
    const rect = canvas.getBoundingClientRect();
    const x = (evt.clientX - rect.left - transform.x) / transform.k;
    const y = (evt.clientY - rect.top - transform.y) / transform.k;

    const dx = x - center.x;
    const dy = y - center.y;
    const cos = Math.cos(-transform.angle);
    const sin = Math.sin(-transform.angle);

    const rotatedX = dx * cos - dy * sin + center.x;
    const rotatedY = dx * sin + dy * cos + center.y;

    return { x: rotatedX, y: rotatedY };
}

function findNearestNode(mousePos) {
    let nearest = null;
    let minDist = 5 / transform.k;
    for (let node of nodes) {
        const dx = node.x - mousePos.x;
        const dy = node.y - mousePos.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < minDist) {
            minDist = dist;
            nearest = node;
        }
    }
    return nearest;
}
