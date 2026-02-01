// 📁 js/infoBox.js

export function renderInfoBox(info, stepIndex = null, totalSteps = null) {
    const box = document.getElementById("infoBox");
    if (!info) {
        box.innerHTML = "<em>No info available</em>";
        return;
    }

    const lines = [
        `District ID: ${info.district_id}`,
        `Target Pop: ${info.target_pop}`,
        `Epsilon: ${info.epsilon}`,
        `Debt: ${info.debt}`,
        `Hired Teams: ${info.hired_teams}`,
        `n_teams: ${info.n_teams}`,
        `Two-Sided: ${info.two_sided}`,
        `Selected Cut: (${info.selected_cut?.[0]}, ${info.selected_cut?.[1]})`,
        `Remaining IDs: ${info.remaining_ids?.size ?? info.remaining_ids?.length ?? 0}`
    ];

    if (stepIndex !== null && totalSteps !== null) {
        lines.unshift(`Step ${stepIndex + 1} / ${totalSteps}`);
    }

    box.innerText = lines.join("\n");
}
