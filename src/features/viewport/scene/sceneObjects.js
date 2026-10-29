export const tagSelectionTarget = (object, type, id) => {
  object.traverse((child) => {
    child.userData.selectionType = type;
    child.userData.selectionId = id;
  });
};

export const selectionForObject = (object) => {
  let current = object;
  while (current) {
    if (current.userData?.selectionType && current.userData?.selectionId) {
      return {
        type: current.userData.selectionType,
        id: current.userData.selectionId,
      };
    }
    current = current.parent;
  }
  return null;
};

export const disposeObject = (object) => {
  object.traverse?.((child) => {
    child.geometry?.dispose?.();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.filter(Boolean).forEach((material) => {
      material.map?.dispose?.();
      material.dispose?.();
    });
  });
};
