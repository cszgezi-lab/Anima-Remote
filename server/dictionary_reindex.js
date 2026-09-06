function normalizeRuleTerms(rule) {
    if (!rule || typeof rule !== "object") {
        return { triggers: [], indexWords: [], signature: "" };
    }

    const triggers = Array.isArray(rule.triggers)
        ? rule.triggers
        : typeof rule.trigger === "string"
          ? rule.trigger.split(/[,，|]/)
          : [];
    const indexWords = Array.isArray(rule.indexWords)
        ? rule.indexWords
        : typeof rule.index === "string"
          ? rule.index.split(/[,，|]/)
          : [];

    const normalizedTriggers = [
        ...new Set(triggers.map((term) => String(term).trim()).filter(Boolean)),
    ].sort();
    const normalizedIndexWords = [
        ...new Set(
            indexWords.map((term) => String(term).trim()).filter(Boolean),
        ),
    ].sort();

    return {
        triggers: normalizedTriggers,
        indexWords: normalizedIndexWords,
        signature: JSON.stringify({
            triggers: normalizedTriggers,
            indexWords: normalizedIndexWords,
        }),
    };
}

function getDictionaryAffectedTerms(oldDictionary, newDictionary) {
    const oldRules = (Array.isArray(oldDictionary) ? oldDictionary : []).map(
        normalizeRuleTerms,
    );
    const newRules = (Array.isArray(newDictionary) ? newDictionary : []).map(
        normalizeRuleTerms,
    );
    const oldSignatures = new Set(oldRules.map((rule) => rule.signature));
    const newSignatures = new Set(newRules.map((rule) => rule.signature));
    const affectedTerms = new Set();

    oldRules.forEach((rule) => {
        if (!newSignatures.has(rule.signature)) {
            [...rule.triggers, ...rule.indexWords].forEach((term) =>
                affectedTerms.add(term),
            );
        }
    });
    newRules.forEach((rule) => {
        if (!oldSignatures.has(rule.signature)) {
            [...rule.triggers, ...rule.indexWords].forEach((term) =>
                affectedTerms.add(term),
            );
        }
    });

    return [...affectedTerms];
}

function findAffectedDocuments(storedFields, affectedTerms) {
    const terms = (Array.isArray(affectedTerms) ? affectedTerms : [])
        .map((term) => String(term).trim())
        .filter(Boolean);
    if (terms.length === 0) return [];

    return Object.values(storedFields || {}).filter((doc) => {
        const text = typeof doc?.text === "string" ? doc.text : "";
        return text && terms.some((term) => text.includes(term));
    });
}

module.exports = {
    findAffectedDocuments,
    getDictionaryAffectedTerms,
    normalizeRuleTerms,
};
