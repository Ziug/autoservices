const ownerStoragePrefix = '/storage/v1/object/public/tenant-media/';

export function mergeOwnerGallery(configuredGallery, storedGallery) {
  const existingGallery = Array.isArray(storedGallery) ? storedGallery : [];
  const configured = configuredGallery.map((photo) => {
    const stored = existingGallery.find((item) => item.id === photo.id);
    const ownerUploaded = typeof stored?.image === 'string' && stored.image.includes(ownerStoragePrefix);
    return ownerUploaded ? {...photo, image: stored.image} : photo;
  });
  const configuredIds = new Set(configured.map((photo) => photo.id));
  const ownerAdded = existingGallery
    .filter((photo) => !configuredIds.has(photo.id))
    .sort((left, right) => left.position - right.position)
    .map((photo, index) => ({...photo, position: configured.length + index}));
  return [...configured, ...ownerAdded];
}
