function normalizeCollectionId(id) {
    if (id === undefined || id === null) return "";
    return String(id).replace(
        /[^a-zA-Z0-9@\-\._\u4e00-\u9fa5]/g,
        "_",
    );
}

function normalizeIgnoreIds(ids) {
    if (!Array.isArray(ids)) return [];

    return [
        ...new Set(
            ids
                .filter((id) => id !== undefined && id !== null)
                .map((id) => String(id).trim())
                .filter(Boolean),
        ),
    ];
}

function shouldApplyIgnoreToCollection(collectionId, ignoreCollectionId) {
    if (!ignoreCollectionId) return true;
    return (
        normalizeCollectionId(collectionId) ===
        normalizeCollectionId(ignoreCollectionId)
    );
}

function isIgnoredSliceId(sliceId, ignoreIds) {
    if (sliceId === undefined || sliceId === null) return false;
    const normalizedId = String(sliceId);
    return normalizeIgnoreIds(ignoreIds).includes(normalizedId);
}

function buildScopedIgnoreFilter(
    baseFilter,
    collectionId,
    ignoreCollectionId,
    ignoreIds,
) {
    const normalizedIds = normalizeIgnoreIds(ignoreIds);
    const filter = baseFilter ? { ...baseFilter } : {};

    if (
        normalizedIds.length > 0 &&
        shouldApplyIgnoreToCollection(collectionId, ignoreCollectionId)
    ) {
        filter.index = { $nin: normalizedIds };
    }

    return Object.keys(filter).length > 0 ? filter : null;
}

module.exports = {
    buildScopedIgnoreFilter,
    isIgnoredSliceId,
    normalizeCollectionId,
    normalizeIgnoreIds,
    shouldApplyIgnoreToCollection,
};
