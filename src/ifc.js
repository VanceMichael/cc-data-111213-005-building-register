// IFC4 model index and relationship interpretation.
//
// The same STEP file is indexed once.  Every relationship is checked in both
// directions (endpoint -> relation and relation -> endpoint) so a damaged
// cross-reference is visible rather than silently dropping a device.  All
// identifiers in the output carry the STEP location of the entity that
// produced them; GlobalId remains the business identifier across deliveries.

import { parseStep, refId, refIds, stringValue } from './step.js';
import { buildUnitContext } from './ifc-units.js';

export const SPATIAL_TYPES = new Set([
  'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY', 'IFCSPACE',
  'IFCSPATIALZONE', 'IFCSPATIALSTRUCTUREELEMENT',
]);

export const RELATION_KINDS = {
  IFCRELDEFINESBYTYPE: 'type',
  IFCRELDEFINESBYPROPERTIES: 'properties',
  IFCRELOVERRIDESPROPERTIES: 'properties',
  IFCRELCONTAINEDINSPATIALSTRUCTURE: 'containment',
  IFCRELAGGREGATES: 'decomposition',
  IFCRELNESTS: 'decomposition',
};

// Building fabric, spatial structure and annotation entities.  Keeping the
// exclusion explicit means an unknown object type still appears in the ledger
// as a candidate instead of disappearing silently.
const NON_DEVICE_TYPES = new Set([
  'IFCPROJECT', 'IFCSITE', 'IFCBUILDING', 'IFCBUILDINGSTOREY', 'IFCSPACE',
  'IFCSPATIALZONE', 'IFCSPATIALSTRUCTUREELEMENT', 'IFCOPENINGELEMENT',
  'IFCOPENINGSTANDARDCASE', 'IFCFEATUREELEMENT', 'IFCVOIDINGFEATURE',
  'IFCCOVERING', 'IFCROOF', 'IFCSLAB', 'IFCSLABSTANDARDCASE',
  'IFCSLABELEMENTEDCASE', 'IFCWALL', 'IFCWALLSTANDARDCASE',
  'IFCWALLELEMENTEDCASE', 'IFCCURTAINWALL', 'IFCCOLUMN',
  'IFCCOLUMNSTANDARDCASE', 'IFCBEAM', 'IFCBEAMSTANDARDCASE', 'IFCMEMBER',
  'IFCMEMBERSTANDARDCASE', 'IFCPLATE', 'IFCPLATESTANDARDCASE',
  'IFSTAIR', 'IFSTAIRFLIGHT', 'IFRAMP', 'IFRAMPFLIGHT', 'IFDOOR',
  'IFWINDOW', 'IFCGRID', 'IFCANNOTATION', 'IFCGRIDAXIS', 'IFCPORT',
  'IFCDISTRIBUTIONPORT', 'IFCRAILING', 'IFCPILE', 'IFCFOOTING',
  'IFCBUILDINGELEMENTPART', 'IFCSTRUCTURALACTION', 'IFCSTRUCTURALACTIVITY',
  'IFCELEMENTASSEMBLY', 'IFCREINFORCINGELEMENT', 'IFCREINFORCINGBAR',
  'IFCREINFORCINGMESH', 'IFCTENDON', 'IFCTENDONANCHOR',
  'IFCVIBRATIONISOLATOR',
]);

const NON_DEVICE_PREFIXES = [
  'IFCREL', 'IFCPROPERTY', 'IFCQUANTITY', 'IFCUNIT', 'IFCMEASURE',
  'IFCGEOMETRIC', 'IFCTOPOLOGICAL', 'IFCPRESENTATION', 'IFCSTYLED',
  'IFCREPRESENTATION', 'IFCAXIS2PLACEMENT', 'IFCLOCALPLACEMENT',
  'IFCOBJECTPLACEMENT', 'IFCCARTESIANPOINT', 'IFCDIRECTION', 'IFCVECTOR',
  'IFCPOLYLINE', 'IFCINDEXEDPOLYCURVE', 'IFCBOUNDINGBOX', 'IFCMATERIAL',
  'IFCCONNECTION',
];

export function isSpatialType(type) {
  return SPATIAL_TYPES.has(type);
}

export function isTypeObject(type) {
  return type.endsWith('TYPE') && type !== 'IFCPROPERTYSET';
}

export function isDeviceCandidate(entity) {
  if (!entity) return false;
  const type = entity.type;
  if (isSpatialType(type)) return false;
  if (isTypeObject(type)) return false;
  if (NON_DEVICE_TYPES.has(type)) return false;
  if (NON_DEVICE_PREFIXES.some(prefix => type.startsWith(prefix))) return false;
  // IfcRoot.GlobalId is the first inherited attribute and is a string for
  // every object, type and relationship.  Anything without one is supporting
  // data (units, placements, values), not a candidate asset.
  if (entity.values[0]?.kind !== 'string') return false;
  return true;
}

export function isPropertySetLike(type) {
  return type === 'IFCPROPERTYSET' || type === 'IFCELEMENTQUANTITY';
}

export function loadIfcModel(text) {
  const parsed = parseStep(text);
  const { entities, byId } = parsed;
  const byType = new Map();
  for (const entity of entities) {
    const list = byType.get(entity.type) ?? [];
    list.push(entity);
    byType.set(entity.type, list);
  }
  const forward = new Map();
  const reverse = new Map();
  const brokenReferences = [];
  for (const entity of entities) {
    const refs = [];
    for (let argumentIndex = 0; argumentIndex < entity.values.length; argumentIndex += 1) {
      for (const id of refIds(entity.values[argumentIndex])) {
        refs.push(id);
        if (!reverse.has(id)) reverse.set(id, []);
        reverse.get(id).push(entity.id);
        if (!byId.has(id)) {
          brokenReferences.push({
            fromStepId: entity.id,
            fromType: entity.type,
            argumentIndex,
            missingStepId: id,
          });
        }
      }
    }
    if (refs.length) forward.set(entity.id, refs);
  }
  const model = { ...parsed, byType, forward, reverse, brokenReferences };
  model.unitContext = buildUnitContext(model);
  model.relations = buildRelationshipIndex(model);
  model.integrity = assessModelIntegrity(model);
  return model;
}

// Structural issues that can hide an entity or make the device roster
// incomplete.  Dependency issues are recorded separately per device.
export function assessModelIntegrity(model) {
  const issues = [];
  const rosterRisks = [];
  for (const issue of model.issues) {
    issues.push(issue);
    if (['unparsed-statement', 'duplicate-step-id', 'unparsed-arguments',
      'unterminated-string', 'unterminated-comment'].includes(issue.code)) {
      rosterRisks.push(issue);
    }
  }
  for (const reference of model.brokenReferences) {
    issues.push({
      code: 'dangling-reference',
      message: `${reference.fromType} #${reference.fromStepId} 的第 ${reference.argumentIndex} 个参数引用了不存在的 #${reference.missingStepId}`,
      ...reference,
    });
  }
  for (const issue of model.relations.issues) {
    issues.push(issue);
  }
  for (const issue of model.unitContext.issues) {
    issues.push(issue);
    if (issue.code === 'missing-unit-assignment') rosterRisks.push(issue);
  }
  return {
    complete: issues.length === 0,
    rosterComplete: rosterRisks.length === 0,
    issues,
    rosterRisks,
  };
}

// Endpoint extraction.  IfcRelationship inherited arguments are GlobalId,
// OwnerHistory, Name, Description; slot 5 is the relating side and slot 6 the
// related side except for spatial containment, where the element list comes
// first.
function relationShape(entity) {
  const values = entity.values;
  const shape = {
    stepId: entity.id,
    ifcType: entity.type,
    kind: RELATION_KINDS[entity.type] ?? null,
    globalId: stringValue(values[0]),
    name: stringValue(values[2]),
    description: stringValue(values[3]),
    relating: null,
    related: [],
    overrides: [],
    malformed: false,
    partial: false,
    notes: [],
  };
  if (!shape.kind) return shape;
  switch (entity.type) {
    case 'IFCRELDEFINESBYTYPE':
    case 'IFCRELDEFINESBYPROPERTIES':
    case 'IFCRELOVERRIDESPROPERTIES':
    case 'IFCRELCONTAINEDINSPATIALSTRUCTURE':
      // IfcRelDefinesByType / IfcRelDefinesByProperties put the related
      // objects in slot 5 and the type or property set in slot 6; spatial
      // containment uses the same order.
      shape.related = refIds(values[4]);
      shape.relating = refId(values[5]);
      if (entity.type === 'IFCRELOVERRIDESPROPERTIES') {
        // OverridingProperties is the argument appended after the inherited
        // IfcRelDefinesByProperties attributes.
        shape.overrides = refIds(values[6]);
      }
      break;
    case 'IFCRELAGGREGATES':
    case 'IFCRELNESTS':
      // IfcRelAggregates / IfcRelNests put the parent in slot 5 and the
      // children in slot 6.
      shape.relating = refId(values[4]);
      shape.related = refIds(values[5]);
      break;
    default:
      break;
  }
  if (shape.relating === null) {
    shape.malformed = true;
    shape.notes.push('缺少 relating 端');
  }
  return shape;
}

function relationIndex(model) {
  const index = {
    relations: [],
    byStepId: new Map(),
    definitions: new Map(),
    propertySets: new Map(),
    containment: new Map(),
    decomposedBy: new Map(),
    typePropertySets: new Map(),
    issues: [],
  };
  const warn = (issue) => index.issues.push(issue);
  for (const entity of model.entities) {
    const shape = relationShape(entity);
    if (!shape.kind) continue;
    index.byStepId.set(shape.stepId, shape);
    index.relations.push(shape);
    const endpointIds = [shape.relating, ...shape.related].filter(id => id !== null);
    for (const id of endpointIds) {
      if (!model.byId.has(id)) {
        shape.partial = true;
        const missingRole = id === shape.relating ? 'relating' : 'related';
        const survivingIds = endpointIds.filter(other => other !== id && model.byId.has(other));
        warn({
          code: 'dangling-relation-endpoint',
          relationStepId: shape.stepId,
          relationType: shape.ifcType,
          missingStepId: id,
          missingRole,
          survivingStepIds: survivingIds,
          survivingGlobalIds: survivingIds
            .map(other => stringValue(model.byId.get(other)?.values?.[0]))
            .filter(Boolean),
          message: `${shape.ifcType} #${shape.stepId} 的 ${missingRole} 端点 #${id} 不存在`,
        });
      }
    }
    if (shape.malformed) {
      shape.partial = true;
      warn({
        code: 'malformed-relation',
        relationStepId: shape.stepId,
        relationType: shape.ifcType,
        message: `${shape.ifcType} #${shape.stepId} 结构不完整`,
      });
    }
    if (shape.kind === 'type') {
      const typeEntity = model.byId.get(shape.relating);
      if (typeEntity && !isTypeObject(typeEntity.type)) {
        shape.partial = true;
        warn({
          code: 'type-relation-target-not-type',
          relationStepId: shape.stepId,
          relatingStepId: shape.relating,
          message: `${shape.ifcType} #${shape.stepId} 的 relating 端 #${shape.relating} 是 ${typeEntity.type}，不是类型对象`,
        });
      }
      for (const relatedId of shape.related) {
        if (!index.definitions.has(relatedId)) index.definitions.set(relatedId, []);
        index.definitions.get(relatedId).push({
          relationStepId: shape.stepId,
          typeStepId: shape.relating,
          partial: shape.partial,
        });
      }
    } else if (shape.kind === 'properties') {
      const setEntity = model.byId.get(shape.relating);
      if (setEntity && !isPropertySetLike(setEntity.type)) {
        shape.partial = true;
        warn({
          code: 'property-relation-target-not-set',
          relationStepId: shape.stepId,
          relatingStepId: shape.relating,
          message: `${shape.ifcType} #${shape.stepId} 的 relating 端 #${shape.relating} 是 ${setEntity.type}，不是属性集`,
        });
      }
      for (const relatedId of shape.related) {
        if (!index.propertySets.has(relatedId)) index.propertySets.set(relatedId, []);
        index.propertySets.get(relatedId).push({
          relationStepId: shape.stepId,
          relationType: shape.ifcType,
          setStepId: shape.relating,
          setName: setEntity ? stringValue(setEntity.values[2]) : null,
          override: shape.ifcType === 'IFCRELOVERRIDESPROPERTIES',
          overridePropertyIds: shape.overrides ?? [],
          partial: shape.partial,
        });
      }
    } else if (shape.kind === 'containment') {
      const spatial = model.byId.get(shape.relating);
      if (spatial && !isSpatialType(spatial.type)) {
        shape.partial = true;
        warn({
          code: 'containment-target-not-spatial',
          relationStepId: shape.stepId,
          relatingStepId: shape.relating,
          message: `${shape.ifcType} #${shape.stepId} 的 relating 端 #${shape.relating} 是 ${spatial.type}，不是空间结构`,
        });
      }
      for (const relatedId of shape.related) {
        if (!index.containment.has(relatedId)) index.containment.set(relatedId, []);
        index.containment.get(relatedId).push({
          relationStepId: shape.stepId,
          spatialStepId: shape.relating,
          partial: shape.partial,
        });
      }
    } else if (shape.kind === 'decomposition') {
      for (const relatedId of shape.related) {
        if (!index.decomposedBy.has(relatedId)) index.decomposedBy.set(relatedId, []);
        index.decomposedBy.get(relatedId).push({
          relationStepId: shape.stepId,
          parentStepId: shape.relating,
          relationType: shape.ifcType,
          partial: shape.partial,
        });
      }
    }
  }
  for (const typeEntity of model.entities) {
    if (!isTypeObject(typeEntity.type)) continue;
    // IfcTypeObject.HasPropertySets: inherited IfcRoot attributes occupy
    // slots 0-3, ApplicableOccurrence is 4 and HasPropertySets is 5.
    const setIds = refIds(typeEntity.values[5]);
    if (setIds.length) index.typePropertySets.set(typeEntity.id, setIds);
  }
  const referencedSets = new Set(
    [...index.propertySets.values()].flat().map(entry => entry.setStepId),
  );
  for (const sets of index.typePropertySets.values()) {
    for (const id of sets) referencedSets.add(id);
  }
  index.unreferencedSets = [
    ...(model.byType.get('IFCPROPERTYSET') ?? []),
    ...(model.byType.get('IFCELEMENTQUANTITY') ?? []),
  ]
    .filter(set => !referencedSets.has(set.id))
    .map(set => ({ stepId: set.id, ifcType: set.type, name: stringValue(set.values[2]) }));
  return index;
}

// Run the relationship pass against a model built from parseStep().  Produces
// the same indexes as loadIfcModel; kept separate so callers that already
// have a parsed file do not pay for unit resolution twice.
export function buildRelationshipIndex(model) {
  if (!model.byType) {
    // A parsed file does not index types yet; build that one index here so
    // the relationship pass can report unreferenced property sets.  The
    // caller's model is left untouched.
    const byType = new Map();
    for (const entity of model.entities) {
      const list = byType.get(entity.type) ?? [];
      list.push(entity);
      byType.set(entity.type, list);
    }
    return relationIndex({ ...model, byType });
  }
  return relationIndex(model);
}

// Property-set contents, read once per set.  Nested values retain their
// declared types; nothing is flattened into an untyped string.
export function readPropertySet(model, setStepId) {
  const entity = model.byId.get(setStepId);
  if (!entity) return null;
  const properties = [];
  // IfcPropertySet puts HasProperties in slot 4; IfcElementQuantity inherits
  // MethodOfMeasurement in slot 4 and puts Quantities in slot 5.
  const listSlot = entity.type === 'IFCELEMENTQUANTITY' ? 5 : 4;
  for (const propertyId of refIds(entity.values[listSlot])) {
    const property = model.byId.get(propertyId);
    if (!property) {
      properties.push({
        kind: 'missing',
        stepId: propertyId,
        name: null,
        value: null,
        unitStepId: null,
      });
      continue;
    }
    if (property.type === 'IFCPROPERTYSINGLEVALUE') {
      properties.push({
        kind: 'single',
        stepId: property.id,
        ifcType: property.type,
        name: stringValue(property.values[0]),
        value: property.values[2],
        unitStepId: refId(property.values[3]),
      });
    } else if (property.type === 'IFCPROPERTYENUMERATEDVALUE') {
      // Name, Description, EnumerationValues (list of IfcValue),
      // EnumerationReference (IfcPropertyEnumeration).
      properties.push({
        kind: 'enumerated',
        stepId: property.id,
        ifcType: property.type,
        name: stringValue(property.values[0]),
        values: property.values[2],
        enumeration: readEnumeration(model, refId(property.values[3])),
        unitStepId: null,
      });
    } else if (property.type === 'IFCPROPERTYLISTVALUE') {
      properties.push({
        kind: 'list',
        stepId: property.id,
        ifcType: property.type,
        name: stringValue(property.values[0]),
        rawValue: property.values[2],
        unitStepId: refId(property.values[3]),
      });
    } else if (property.type === 'IFCPROPERTYBOUNDEDVALUE') {
      properties.push({
        kind: 'bounded',
        stepId: property.id,
        ifcType: property.type,
        name: stringValue(property.values[0]),
        upper: property.values[2],
        lower: property.values[3],
        unitStepId: refId(property.values[4]),
        setPoint: property.values[5],
      });
    } else if (property.type.startsWith('IFCQUANTITY')) {
      // IfcPhysicalSimpleQuantity: Name, Description, Unit; the subtype adds
      // its measured value and formula after the inherited attributes.
      properties.push({
        kind: 'quantity',
        stepId: property.id,
        ifcType: property.type,
        name: stringValue(property.values[0]),
        value: property.values[3],
        unitStepId: refId(property.values[2]),
      });
    } else if (property.type === 'IFCPROPERTYREFERENCEVALUE') {
      properties.push({
        kind: 'reference',
        stepId: property.id,
        ifcType: property.type,
        name: stringValue(property.values[0]),
        value: property.values[3],
        unitStepId: null,
      });
    } else {
      properties.push({
        kind: 'other',
        stepId: property.id,
        ifcType: property.type,
        name: stringValue(property.values[0]),
        raw: property.values,
        unitStepId: null,
      });
    }
  }
  return {
    stepId: entity.id,
    ifcType: entity.type,
    globalId: stringValue(entity.values[0]),
    name: stringValue(entity.values[2]),
    properties,
  };
}

function readEnumeration(model, enumerationId) {
  const entity = enumerationId ? model.byId.get(enumerationId) : null;
  if (!entity) return null;
  return {
    stepId: entity.id,
    name: stringValue(entity.values[0]),
    values: entity.values[1],
    unitStepId: refId(entity.values[2]),
  };
}



