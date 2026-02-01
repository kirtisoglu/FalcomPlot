// Tolerance logic
export class ToleranceChecker {
    isWithinTolerance(node, metadata) {
        if (!metadata || node.population == null) return false;
        const P = Number(node.population);
        const I = Number(metadata.ideal_pop);
        const eps = Number(metadata.epsilon);

        if (!Number.isFinite(P) || !Number.isFinite(I) || !Number.isFinite(eps)) return false;

        for (const k of [1, 2]) {
            const lhs = Math.abs(P - k * I);
            const rhs = I * k * eps;
            if (lhs <= rhs) return true;
        }
        return false;
    }
}