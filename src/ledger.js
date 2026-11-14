// Device ledger built from the IFC4 relationship network.
//
// A device is not a bag of property names.  Each row keeps:
//   - identity: GlobalId (business identity across deliveries), STEP id
//     (location in this file), name, type and tag;
//   - placement: containment plus decomposition hops, every hop named by the
//     relationship that produced it;
//   - type definitions: the type object, its property sets and explicit
//     override relations;
//   - property sources: one observation per property step, never merged just
//     because another source happens to use the same property name;
//   - conflicts and unresolved dependencies, each pointing at STEP lines.

import {
  isDeviceCandidate, isTypeObject, loadIfcModel, readPropertySet,
} from './ifc.js';
import { explainMeasure } from './ifc-units.js';
import { encodeValue, refIds, stringValue } from './step.js';

function enumNameOf(value) {
  if (!value) return null;
  if (value.kind === 'enum') return value.value;
  if (value.kind === 'typed') return value.valueType;
  return null;
}

function identityOf(entity) {
  return {
    globalId: stringValue(entity.values[0]),
    stepId: entity.id,
    ifcType: entity.type,
    name: stringValue(entity.values[2]),
    description: stringValue(entity.values[3]),
    objectType: stringValue(entity.values[4]),
    tag: stringValue(entity.values[7]) ?? null,
    predefinedType: enumNameOf(entity.values[entity.values.length - 1]),
  };
}

function spatialInfo(model, stepId) {
  const entity = model.byId.get(stepId);
  if (!entity) return null;
  return {
    stepId,
    ifcType: entity.type,
    globalId: stringValue(entity.values[0]),
    name: stringValue(entity.values[2]),
    predefinedType: enumNameOf(entity.values[entity.values.length - 1]),
  };
}

// Climb IfcRelAggregates from a spatial element to its enclosing structure
// (storey -> building -> site).  Every hop names the relationship it came
// from, so a placement can be traced back one link at a time.
function spatialAncestors(model, startStepId) {
  const path = [];
  const visited = new Set([startStepId]);
  let current = startStepId;
  for (;;) {
    const parents = model.relations.decomposedBy.get(current) ?? [];
    if (!parents.length) break;
    for (const extra of parents.slice(1)) {
      path.push({
        kind: 'decomposition-branch',
        relationStepId: extra.relationStepId,
        note: `#${current} 存在多条分解父关系`,
      });
    }
    const parent = parents[0];
    if (visited.has(parent.parentStepId)) {
      path.push({
        kind: 'decomposition-cycle',
        relationStepId: parent.relationStepId,
        note: '空间分解出现循环',
      });
      break;
    }
    visited.add(parent.parentStepId);
    path.push({
      kind: 'decomposition',
      relationStepId: parent.relationStepId,
      relationType: parent.relationType,
      parent: spatialInfo(model, parent.parentStepId),
    });
    current = parent.parentStepId;
  }
  return path;
}

// Resolve a device's placement.  Direct containment and decomposition are
// both considered: a part may be listed under a storey while its assembly is
// listed elsewhere, and that disagreement must stay visible rather than being
// resolved silently.  Every candidate names the relationships it came from.
function placementOf(model, deviceId) {
  const issues = [];
  const candidates = [];
  for (const entry of model.relations.containment.get(deviceId) ?? []) {
    candidates.push({ via: 'direct', entry });
    if (entry.partial) {
      issues.push({
        code: 'partial-containment',
        relationStepId: entry.relationStepId,
        message: `空间包含关系 #${entry.relationStepId} 解析不完整`,
      });
    }
  }
  // Walk the decomposition parents once per device, recording each hop.
  const visited = new Set([deviceId]);
  let current = deviceId;
  const hops = [];
  for (let depth = 0; depth < 32; depth += 1) {
    const parents = model.relations.decomposedBy.get(current) ?? [];
    if (parents.length > 1) {
      issues.push({
        code: 'multiple-decomposition-parents',
        stepIds: parents.map(parent => parent.relationStepId),
        message: `#${current} 存在多条分解父关系`,
      });
    }
    const parent = parents[0];
    if (!parent) break;
    if (visited.has(parent.parentStepId)) {
      issues.push({
        code: 'decomposition-cycle',
        relationStepId: parent.relationStepId,
        stepIds: [...visited, parent.parentStepId],
        message: '分解组合出现循环',
      });
      break;
    }
    visited.add(parent.parentStepId);
    hops.push({
      kind: 'decomposition',
      relationStepId: parent.relationStepId,
      relationType: parent.relationType,
      from: spatialInfo(model, current),
      to: spatialInfo(model, parent.parentStepId),
    });
    const contained = model.relations.containment.get(parent.parentStepId) ?? [];
    if (contained.length) {
      candidates.push(...contained.map(entry => ({
        via: 'decomposition',
        entry,
        hops: [...hops],
      })));
      break;
    }
    current = parent.parentStepId;
  }
  const resolved = candidates.map((candidate) => {
    const container = spatialInfo(model, candidate.entry.spatialStepId);
    return {
      via: candidate.via,
      relationStepId: candidate.entry.relationStepId,
      relationType: candidate.via === 'direct'
        ? 'IFCRELCONTAINEDINSPATIALSTRUCTURE'
        : candidate.hops[0].relationType,
      spatial: container,
      spatialPath: container ? spatialAncestors(model, container.stepId) : [],
      ...(candidate.hops?.length ? { hops: candidate.hops } : {}),
      ...(candidate.entry.partial ? { partial: true } : {}),
    };
  });
  let status;
  if (resolved.length === 0) status = 'unassigned';
  else if (resolved.length === 1) status = resolved[0].partial ? 'partial' : 'contained';
  else status = 'ambiguous';
  if (status === 'unassigned') {
    issues.push({
      code: 'no-spatial-containment',
      message: '设备没有空间归属（直接包含和分解父节点均未找到）',
    });
  }
  if (resolved.length > 1) {
    issues.push({
      code: 'multiple-spatial-containers',
      relationStepIds: resolved.map(entry => entry.relationStepId),
      message: '设备落在多个空间容器中',
    });
  }
  return { status, containers: resolved, issues };
}

// Interpret one IfcValue according to its declared type.  Measures are
// normalized through the unit chain; literals and enum literals stay typed.
function interpretValue(model, propertyStepId, value, explicitUnitId) {
  if (!value) {
    return { kind: 'absent', value: null };
  }
  if (value.kind === 'typed') {
    const declaredType = value.valueType;
    const inner = value.values[0] ?? null;
    if (inner?.kind === 'number') {
      const explanation = explainMeasure({
        declaredType,
        rawValue: inner.value,
        explicitUnitId,
        unitContext: model.unitContext,
        propertyStepId,
      });
      return {
        kind: 'measure',
        declaredType,
        raw: inner.value,
        ...explanation,
      };
    }
    if (inner?.kind === 'string') {
      return { kind: 'literal', declaredType, value: inner.value };
    }
    if (inner?.kind === 'boolean') {
      return { kind: 'boolean', declaredType, value: inner.value };
    }
    if (inner?.kind === 'enum') {
      return { kind: 'enum', declaredType, value: inner.value, literal: inner.literal };
    }
    if (inner?.kind === 'list') {
      return {
        kind: 'aggregate',
        declaredType,
        items: inner.items.map(item => interpretValue(model, propertyStepId, item, explicitUnitId)),
      };
    }
    if (inner?.kind === 'ref') {
      return { kind: 'reference', declaredType, stepId: inner.id };
    }
    return { kind: 'typed', declaredType, value: encodeValue(inner) };
  }
  if (value.kind === 'number') {
    return { kind: 'number', value: value.value };
  }
  if (value.kind === 'string') {
    return { kind: 'string', value: value.value };
  }
  if (value.kind === 'enum') {
    return { kind: 'enum', value: value.value, literal: value.literal };
  }
  if (value.kind === 'boolean') {
    return { kind: 'boolean', value: value.value };
  }
  if (value.kind === 'list') {
    return {
      kind: 'aggregate',
      items: value.items.map(item => interpretValue(model, propertyStepId, item, explicitUnitId)),
    };
  }
  return { kind: value.kind, raw: encodeValue(value) };
}

// Turn a property set read from the model into ledger observations.  Each
// observation is a separate row; two sources with the same property name stay
// separate rows and are linked only by the conflict record.
function observationsFromSet(model, set) {
  const observations = [];
  const issues = [];
  for (const property of set.properties) {
    const base = {
      propertyStepId: property.stepId,
      propertyIfcType: property.ifcType,
      propertyKind: property.kind,
      propertyName: property.name,
      name: property.name,
      sourceSetStepId: set.stepId,
      sourceSetGlobalId: set.globalId,
      sourceSetName: set.name,
    };
    if (property.kind === 'missing') {
      observations.push({
        ...base,
        value: { kind: 'missing', stepId: property.stepId },
        unresolved: true,
      });
      issues.push({
        code: 'missing-property',
        propertyStepId: property.stepId,
        setStepId: set.stepId,
        message: `属性集 #${set.stepId} 引用了不存在的属性 #${property.stepId}`,
      });
      continue;
    }
    if (property.kind === 'single') {
      const value = interpretValue(model, property.stepId, property.value, property.unitStepId);
      observations.push({ ...base, value, unresolved: value.unresolved === true });
      if (value.kind === 'measure' && value.warnings?.length) {
        issues.push(...value.warnings.map(warning => ({
          ...warning,
          propertyStepId: property.stepId,
          setStepId: set.stepId,
        })));
      }
    } else if (property.kind === 'enumerated') {
      const raw = property.values;
      const items = raw?.kind === 'list'
        ? raw.items.map(item => interpretValue(model, property.stepId, item, null))
        : [interpretValue(model, property.stepId, raw, null)];
      observations.push({
        ...base,
        value: {
          kind: 'enumerated',
          items,
          enumeration: property.enumeration,
          declaredTypes: items.map(item => item.declaredType).filter(Boolean),
        },
      });
    } else if (property.kind === 'list') {
      const raw = property.rawValue;
      const items = raw?.kind === 'list'
        ? raw.items.map(item => interpretValue(model, property.stepId, item, property.unitStepId))
        : [interpretValue(model, property.stepId, raw, property.unitStepId)];
      observations.push({
        ...base,
        value: { kind: 'list', items, declaredTypes: items.map(item => item.declaredType).filter(Boolean) },
      });
      issues.push(...items.flatMap(item => item.warnings ?? []).map(warning => ({
        ...warning, propertyStepId: property.stepId, setStepId: set.stepId,
      })));
    } else if (property.kind === 'bounded') {
      const explicitUnit = property.unitStepId;
      observations.push({
        ...base,
        value: {
          kind: 'bounded',
          upper: interpretValue(model, property.stepId, property.upper, explicitUnit),
          lower: interpretValue(model, property.stepId, property.lower, explicitUnit),
          setPoint: interpretValue(model, property.stepId, property.setPoint, explicitUnit),
        },
      });
    } else if (property.kind === 'quantity') {
      observations.push({
        ...base,
        value: interpretValue(model, property.stepId, property.value, property.unitStepId),
        unresolved: property.value === null,
      });
    } else if (property.kind === 'reference') {
      observations.push({
        ...base,
        value: interpretValue(model, property.stepId, property.value, null),
      });
    } else {
      observations.push({
        ...base,
        value: { kind: 'other', ifcType: property.ifcType, raw: property.raw },
        unresolved: true,
      });
      issues.push({
        code: 'unsupported-property-kind',
        propertyStepId: property.stepId,
        setStepId: set.stepId,
        message: `属性 #${property.stepId} 的类型 ${property.ifcType} 没有专门读取`,
      });
    }
  }
  return { observations, issues };
}

// A comparison token for the diff.  Measures use their normalized value plus
// the unit; nested values keep their declared types.  Nothing is converted to
// an untyped display string.
function valueToken(value) {
  if (!value) return { type: 'absent' };
  switch (value.kind) {
    case 'measure':
      return {
        type: 'measure',
        declaredType: value.declaredType,
        raw: value.rawValue,
        unitSource: value.unitSource,
        unitStepId: value.unit?.stepId ?? null,
        unitSymbol: value.unit?.symbol ?? null,
        canonical: value.canonical?.value ?? null,
        canonicalUnit: value.canonical?.symbol ?? null,
        formula: value.canonical?.formula ?? null,
        unresolved: value.canonical === null,
      };
    case 'literal':
      return { type: 'literal', declaredType: value.declaredType, value: value.value };
    case 'enum':
      return { type: 'enum', declaredType: value.declaredType ?? null, value: value.value };
    case 'boolean':
      return { type: 'boolean', declaredType: value.declaredType ?? null, value: value.value };
    case 'number':
      return { type: 'number', value: value.value };
    case 'string':
      return { type: 'string', value: value.value };
    case 'aggregate':
      return {
        type: 'aggregate',
        declaredType: value.declaredType ?? null,
        items: (value.items ?? []).map(valueToken),
      };
    case 'list':
      return {
        type: 'list',
        items: (value.items ?? []).map(valueToken),
      };
    case 'enumerated':
      return {
        type: 'enumerated',
        items: (value.items ?? []).map(valueToken),
        enumerationStepId: value.enumeration?.stepId ?? null,
      };
    case 'bounded':
      return {
        type: 'bounded',
        lower: valueToken(value.lower),
        upper: valueToken(value.upper),
        setPoint: valueToken(value.setPoint),
      };
    case 'reference':
      return { type: 'reference', declaredType: value.declaredType ?? null, stepId: value.stepId };
    case 'missing':
      return { type: 'missing', stepId: value.stepId };
    default:
      return { type: value.kind };
  }
}

function unresolvedValue(value) {
  if (!value) return false;
  if (value.kind === 'measure' && value.canonical === null) return true;
  if (value.unresolved) return true;
  if (value.kind === 'bounded') {
    return unresolvedValue(value.lower) || unresolvedValue(value.upper) || unresolvedValue(value.setPoint);
  }
  if (['list', 'aggregate', 'enumerated'].includes(value.kind)) {
    return (value.items ?? []).some(unresolvedValue);
  }
  return false;
}

function fieldEntriesForSource(source) {
  // Same-named properties within one set are disambiguated by occurrence, not
  // by file order, so the key stays stable when unrelated properties move.
  const occurrences = new Map();
  return source.observations.map((observation) => {
    const name = observation.propertyName ?? '(未命名)';
    const occurrence = occurrences.get(name) ?? 0;
    occurrences.set(name, occurrence + 1);
    const token = valueToken(observation.value);
    return {
      key: [
        'property',
        source.sourceKind,
        source.typeStepId ?? '',
        source.setGlobalId ?? source.setStepId,
        name,
        occurrence,
      ].join('|'),
      label: observation.propertyName,
      category: 'property',
      sourceKind: source.sourceKind,
      source: {
        kind: source.sourceKind,
        relationStepId: source.relationStepId ?? null,
        overrideRelationStepId: source.overrideRelationStepId ?? null,
        typeStepId: source.typeStepId ?? null,
        setStepId: source.setStepId,
        setGlobalId: source.setGlobalId,
        propertyStepId: observation.propertyStepId,
        overridden: observation.overridden === true,
      },
      value: token,
      display: displayValue(observation.value),
      unresolved: unresolvedValue(observation.value),
    };
  });
}

function displayValue(value) {
  if (!value) return null;
  switch (value.kind) {
    case 'measure':
      return value.canonical
        ? `${value.raw} ${value.unit?.symbol ?? ''} → ${value.canonical.value} ${value.canonical.symbol}`.trim()
        : `${value.raw} ${value.declaredType}（单位未解析）`;
    case 'literal':
      return `${value.value} (${value.declaredType})`;
    case 'enum':
      return `${value.value} (${value.declaredType ?? 'enum'})`;
    case 'boolean':
      return `${value.value} (${value.declaredType ?? 'boolean'})`;
    case 'aggregate':
    case 'list':
      return (value.items ?? []).map(displayValue).join(', ');
    case 'enumerated':
      return (value.items ?? []).map(displayValue).join(' | ');
    case 'bounded':
      return `[${displayValue(value.lower)}, ${displayValue(value.upper)}]`;
    default:
      return JSON.stringify(valueToken(value));
  }
}

// Build one property source from a set plus its provenance.
function sourceFromSet(model, setStepId, provenance) {
  const set = readPropertySet(model, setStepId);
  if (!set) {
    return {
      ...provenance,
      setStepId,
      observations: [],
      issues: [{
        code: 'missing-property-set',
        setStepId,
        relationStepId: provenance.relationStepId ?? null,
        message: `属性集 #${setStepId} 不存在`,
      }],
    };
  }
  const { observations, issues } = observationsFromSet(model, set);
  return {
    ...provenance,
    setStepId: set.stepId,
    setGlobalId: set.globalId,
    setName: set.name,
    setIfcType: set.ifcType,
    observations,
    issues,
  };
}

// Collect every type object that defines a device, its direct property sets
// and any explicit override relations.
function typeDefinitionsOf(model, deviceId) {
  const definitions = model.relations.definitions.get(deviceId) ?? [];
  const entries = [];
  const issues = [];
  for (const definition of definitions) {
    const typeEntity = model.byId.get(definition.typeStepId);
    if (!typeEntity) {
      issues.push({
        code: 'missing-type-object',
        relationStepId: definition.relationStepId,
        typeStepId: definition.typeStepId,
        message: `类型分配关系 #${definition.relationStepId} 引用的类型对象 #${definition.typeStepId} 不存在`,
      });
      entries.push({
        relationStepId: definition.relationStepId,
        typeStepId: definition.typeStepId,
        partial: true,
        propertySets: [],
      });
      continue;
    }
    if (!isTypeObject(typeEntity.type)) {
      issues.push({
        code: 'type-relation-target-not-type',
        relationStepId: definition.relationStepId,
        typeStepId: typeEntity.id,
        message: `类型分配关系 #${definition.relationStepId} 的 relating 端是 ${typeEntity.type}`,
      });
    }
    const setIds = model.relations.typePropertySets.get(typeEntity.id) ?? [];
    const propertySets = [];
    const sources = [];
    for (const setId of setIds) {
      const source = sourceFromSet(model, setId, {
        sourceKind: 'type-object',
        relationStepId: null,
        typeStepId: typeEntity.id,
        typeGlobalId: stringValue(typeEntity.values[0]),
        typeName: stringValue(typeEntity.values[2]),
        via: {
          kind: 'type-object-property-sets',
          typeStepId: typeEntity.id,
          argumentIndex: 5,
        },
      });
      propertySets.push(source);
      sources.push(source);
      issues.push(...source.issues);
    }
    entries.push({
      relationStepId: definition.relationStepId,
      typeStepId: typeEntity.id,
      typeGlobalId: stringValue(typeEntity.values[0]),
      typeName: stringValue(typeEntity.values[2]),
      typeIfcType: typeEntity.type,
      predefinedType: enumNameOf(typeEntity.values[typeEntity.values.length - 1]),
      tag: stringValue(typeEntity.values[7]),
      partial: definition.partial === true,
      propertySets,
      mappings: [],
    });
  }
  if (entries.length > 1) {
    issues.push({
      code: 'multiple-type-definitions',
      relationStepIds: entries.map(entry => entry.relationStepId),
      typeStepIds: entries.map(entry => entry.typeStepId),
      message: '同一设备被多个类型分配关系定义',
    });
  }
  return { entries, issues, sources: entries.flatMap(entry => entry.propertySets) };
}

// Explicit IfcRelOverridesProperties links only the named property steps;
// that is the only case in which the ledger states an effective override.
function overrideInformation(model, deviceId) {
  const relations = model.relations.propertySets.get(deviceId) ?? [];
  const overrides = [];
  const issues = [];
  for (const relation of relations) {
    if (!relation.override) continue;
    const overrideIds = relation.overridePropertyIds ?? [];
    const set = model.byId.get(relation.setStepId);
    const listSlot = set?.type === 'IFCELEMENTQUANTITY' ? 5 : 4;
    const known = new Set(refIds(set?.values?.[listSlot] ?? null));
    for (const id of overrideIds) {
      if (!known.has(id)) {
        issues.push({
          code: 'override-outside-property-set',
          relationStepId: relation.relationStepId,
          propertyStepId: id,
          message: `#${relation.relationStepId} 覆盖的属性 #${id} 不属于属性集 #${relation.setStepId}`,
        });
      }
    }
    overrides.push({
      relationStepId: relation.relationStepId,
      setStepId: relation.setStepId,
      propertyStepIds: overrideIds,
    });
  }
  return { overrides, issues };
}

function instanceSourcesOf(model, deviceId) {
  const relations = model.relations.propertySets.get(deviceId) ?? [];
  const sources = [];
  const issues = [];
  for (const relation of relations) {
    const source = sourceFromSet(model, relation.setStepId, {
      sourceKind: relation.override ? 'instance-override' : 'instance',
      relationStepId: relation.relationStepId,
      relationType: relation.relationType,
      setName: relation.setName,
      override: relation.override === true,
      overridePropertyIds: relation.overridePropertyIds ?? [],
      via: {
        kind: 'relationship',
        relationStepId: relation.relationStepId,
        relationType: relation.relationType,
        relatingEndpoint: relation.setStepId,
        relatedEndpoint: deviceId,
      },
    });
    sources.push(source);
    issues.push(...source.issues);
    if (relation.partial) {
      issues.push({
        code: 'partial-property-relation',
        relationStepId: relation.relationStepId,
        message: `属性关系 #${relation.relationStepId} 解析不完整`,
      });
    }
  }
  return { sources, issues };
}

// Same property name across different property sources is a conflict, not a
// merge.  Equal values still remain separate observations.
function conflictsOf(device) {
  const conflicts = [];
  const byName = new Map();
  for (const source of device.propertySources) {
    for (const observation of source.observations) {
      if (observation.propertyName === null) continue;
      if (!byName.has(observation.propertyName)) byName.set(observation.propertyName, []);
      byName.get(observation.propertyName).push({ source, observation });
    }
  }
  for (const [name, entries] of byName.entries()) {
    const sourceKeys = new Set(entries.map(entry => [
      entry.source.sourceKind,
      entry.source.typeStepId ?? '',
      entry.source.setGlobalId ?? entry.source.setStepId,
    ].join(':')));
    // Two observations in the same source are not a cross-source conflict.
    if (sourceKeys.size < 2) continue;
    const tokens = entries.map(entry => JSON.stringify(valueToken(entry.observation.value)));
    const distinct = new Set(tokens);
    conflicts.push({
      code: distinct.size > 1 ? 'property-name-conflict' : 'property-name-duplicate',
      propertyName: name,
      distinctValues: distinct.size > 1,
      sources: entries.map(entry => ({
        sourceKind: entry.source.sourceKind,
        relationStepId: entry.source.relationStepId ?? null,
        overrideRelationStepId: entry.source.overrideRelationStepId ?? null,
        typeStepId: entry.source.typeStepId ?? null,
        setStepId: entry.source.setStepId,
        setGlobalId: entry.source.setGlobalId,
        propertyStepId: entry.observation.propertyStepId,
        overridden: entry.observation.overridden === true,
        valueToken: valueToken(entry.observation.value),
        display: displayValue(entry.observation.value),
      })),
      message: distinct.size > 1
        ? `属性名“${name}”在多个来源中取值不同，未合并`
        : `属性名“${name}”在多个来源中重复，来源保持分开`,
    });
  }
  return conflicts;
}

function deviceRow(model, entity, sameNameLookup) {
  const identity = identityOf(entity);
  const placement = placementOf(model, entity.id);
  const typeDefinitions = typeDefinitionsOf(model, entity.id);
  const instance = instanceSourcesOf(model, entity.id);
  const overrides = overrideInformation(model, entity.id);
  const propertySources = [
    ...typeDefinitions.sources,
    ...instance.sources,
  ];
  const issues = [
    ...placement.issues,
    ...typeDefinitions.issues,
    ...instance.issues,
    ...overrides.issues,
  ];
  const conflicts = conflictsOf({ propertySources });
  // Grouping by name is reported separately so operators can see duplicate
  // tags without any automatic identity decision.
  const sameName = sameNameLookup.get(identity.name) ?? null;
  const relations = [];
  for (const definition of model.relations.definitions.get(entity.id) ?? []) {
    relations.push({ kind: 'type', relationStepId: definition.relationStepId, typeStepId: definition.typeStepId });
  }
  for (const relation of model.relations.propertySets.get(entity.id) ?? []) {
    relations.push({
      kind: relation.override ? 'properties-override' : 'properties',
      relationStepId: relation.relationStepId,
      setStepId: relation.setStepId,
    });
  }
  for (const entry of model.relations.containment.get(entity.id) ?? []) {
    relations.push({ kind: 'containment', relationStepId: entry.relationStepId, spatialStepId: entry.spatialStepId });
  }
  for (const entry of model.relations.decomposedBy.get(entity.id) ?? []) {
    relations.push({ kind: 'decomposition', relationStepId: entry.relationStepId, parentStepId: entry.parentStepId });
  }
  // Override relations name individual property steps.  Those steps are not
  // otherwise distinguishable from the set they belong to, so they are
  // annotated here and the field source carries the override relation id.
  for (const override of overrides.overrides) {
    for (const source of propertySources) {
      if (source.setStepId !== override.setStepId) continue;
      source.overrideRelationStepId = override.relationStepId;
      for (const observation of source.observations) {
        observation.overridden = override.propertyStepIds.includes(observation.propertyStepId);
      }
    }
  }
  const dataUnresolved = propertySources.some(source =>
    source.issues.length > 0 ||
    source.observations.some(observation => unresolvedValue(observation.value)));
  const presenceIssues = [];
  if (!identity.globalId) {
    presenceIssues.push({
      code: 'missing-global-id',
      stepId: entity.id,
      message: `设备 #${entity.id} 没有 GlobalId，无法跨次交付匹配`,
    });
  }
  if (sameName && sameName.length > 1) {
    presenceIssues.push({
      code: 'duplicate-device-name',
      name: identity.name,
      stepIds: sameName.map(item => item.stepId),
      message: `同名设备“${identity.name}”有 ${sameName.length} 台`,
    });
  }
  const resolution = {
    presence: {
      status: presenceIssues.length ? 'ambiguous' : 'identified',
      issues: presenceIssues,
    },
    data: {
      status: dataUnresolved ? 'partial' : 'complete',
      issues: propertySources.flatMap(source => source.issues),
    },
  };
  const row = {
    identity,
    placement,
    typeDefinitions: {
      entries: typeDefinitions.entries,
      sources: typeDefinitions.sources,
    },
    propertySources,
    overrides: overrides.overrides,
    conflicts,
    issues,
    resolution,
    relations,
  };
  row.fields = buildFields(row);
  attachStepLocations(model, row);
  return row;
}

// Every source reference is resolved to its file line so a ledger row can be
// followed back to the exact STEP statement without re-reading the model.
function attachStepLocations(model, row) {
  const locate = (stepId) => {
    const entity = model.byId.get(stepId);
    return entity ? entity.stepLine : null;
  };
  for (const source of row.propertySources) {
    source.stepLines = {
      set: locate(source.setStepId),
      relation: source.relationStepId ? locate(source.relationStepId) : null,
      type: source.typeStepId ? locate(source.typeStepId) : null,
      overrideRelation: source.overrideRelationStepId
        ? locate(source.overrideRelationStepId)
        : null,
    };
  }
  for (const field of row.fields) {
    if (!field.source) continue;
    if (field.source.propertyStepId) {
      field.source.propertyStepLine = locate(field.source.propertyStepId);
    }
    if (field.source.setStepId) field.source.setStepLine = locate(field.source.setStepId);
    if (field.source.relationStepId) {
      field.source.relationStepLine = locate(field.source.relationStepId);
    }
    if (field.source.typeStepId) field.source.typeStepLine = locate(field.source.typeStepId);
    if (field.source.stepId) field.source.stepLine = locate(field.source.stepId);
  }
  for (const conflict of row.conflicts) {
    for (const source of conflict.sources) {
      source.stepLine = locate(source.propertyStepId);
      source.relationStepLine = source.relationStepId ? locate(source.relationStepId) : null;
    }
  }
  for (const relation of row.relations) {
    relation.stepLine = locate(relation.relationStepId);
  }
  for (const entry of row.typeDefinitions.entries) {
    entry.relationStepLine = locate(entry.relationStepId);
    entry.typeStepLine = locate(entry.typeStepId);
  }
  for (const container of row.placement.containers) {
    container.relationStepLine = locate(container.relationStepId);
    container.spatialStepLine = container.spatial?.stepId ? locate(container.spatial.stepId) : null;
    for (const hop of container.hops ?? []) hop.relationStepLine = locate(hop.relationStepId);
    for (const hop of container.spatialPath ?? []) hop.relationStepLine = locate(hop.relationStepId);
  }
}

function buildFields(row) {
  const fields = [];
  fields.push({
    key: 'identity|name',
    label: '设备名称',
    category: 'identity',
    value: { name: row.identity.name },
    display: row.identity.name,
    unresolved: row.identity.name === null,
    source: { kind: 'entity', stepId: row.identity.stepId, globalId: row.identity.globalId },
  });
  fields.push({
    key: 'identity|tag',
    label: '设备位号',
    category: 'identity',
    value: { tag: row.identity.tag },
    display: row.identity.tag,
    unresolved: row.identity.tag === null,
    source: { kind: 'entity', stepId: row.identity.stepId, globalId: row.identity.globalId },
  });
  for (const source of row.propertySources) {
    fields.push(...fieldEntriesForSource(source));
  }
  fields.push({
    key: 'placement|status',
    label: '空间归属',
    category: 'placement',
    value: { status: row.placement.status },
    display: row.placement.status,
    unresolved: row.placement.status === 'partial' ||
      row.placement.status === 'ambiguous' ||
      row.placement.status === 'unassigned',
    source: { kind: 'relationship', relationStepIds: row.placement.containers.map(entry => entry.relationStepId) },
  });
  fields.push({
    key: 'placement|containers',
    label: '空间容器',
    category: 'placement',
    value: {
      containers: row.placement.containers.map(entry => ({
        via: entry.via,
        spatialGlobalId: entry.spatial?.globalId ?? null,
        spatialName: entry.spatial?.name ?? null,
        relationStepId: entry.relationStepId,
        hops: entry.hops ?? [],
        spatialPath: entry.spatialPath ?? [],
      })),
    },
    display: row.placement.containers
      .map(entry => entry.spatial?.name ?? `#${entry.relationStepId}`)
      .join(' / '),
    unresolved: row.placement.containers.length === 0 ||
      row.placement.containers.some(entry => entry.partial === true),
    source: {
      kind: 'relationship',
      relationStepIds: row.placement.containers.map(entry => entry.relationStepId),
    },
  });
  // Type objects are keyed by their GlobalId only: a repaired or renumbered
  // relation for the same type is not a material change, while swapping the
  // type object is.
  for (const entry of row.typeDefinitions.entries) {
    fields.push({
      key: `type|${entry.typeGlobalId ?? `step-${entry.typeStepId}`}`,
      label: '类型对象',
      category: 'type',
      value: {
        typeGlobalId: entry.typeGlobalId ?? null,
        typeStepId: entry.typeStepId,
        typeIfcType: entry.typeIfcType ?? null,
        typeName: entry.typeName ?? null,
        relationStepId: entry.relationStepId,
      },
      display: [entry.typeName, entry.typeIfcType].filter(Boolean).join(' / '),
      unresolved: entry.partial === true,
      source: { kind: 'relationship', relationStepId: entry.relationStepId, typeStepId: entry.typeStepId },
    });
  }
  return fields;
}

function globalIdGroups(model) {
  const groups = new Map();
  for (const entity of model.entities) {
    if (!isDeviceCandidate(entity)) continue;
    const globalId = stringValue(entity.values[0]);
    if (!globalId) continue;
    if (!groups.has(globalId)) groups.set(globalId, []);
    groups.get(globalId).push(entity);
  }
  return groups;
}

export function buildDeviceLedger(model, { source = null } = {}) {
  const names = new Map();
  for (const entity of model.entities) {
    if (!isDeviceCandidate(entity)) continue;
    const name = stringValue(entity.values[2]);
    if (name === null) continue;
    if (!names.has(name)) names.set(name, []);
    names.get(name).push({ stepId: entity.id, globalId: stringValue(entity.values[0]), ifcType: entity.type });
  }
  const duplicateNames = [...names.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([name, entries]) => ({ name, devices: entries }));
  const devices = [];
  for (const entity of model.entities) {
    if (!isDeviceCandidate(entity)) continue;
    devices.push(deviceRow(model, entity, names));
  }
  const globalIdGroupsResult = [...globalIdGroups(model).entries()]
    .filter(([, entities]) => entities.length > 1)
    .map(([globalId, entities]) => ({
      globalId,
      stepIds: entities.map(entity => entity.id),
      names: entities.map(entity => stringValue(entity.values[2])),
    }));
  const ledgerIssues = [...model.integrity.issues];
  for (const group of globalIdGroupsResult) {
    ledgerIssues.push({
      code: 'duplicate-global-id',
      globalId: group.globalId,
      stepIds: group.stepIds,
      message: `GlobalId ${group.globalId} 在本次交付中出现 ${group.stepIds.length} 次`,
    });
  }
  const seenIssues = new Set();
  const pushIssue = (issue) => {
    // Device rows share file-level issues (a duplicated name, one dangling
    // relation); report each distinct issue once at ledger level.
    const key = JSON.stringify([
      issue.code, issue.stepId ?? null, issue.relationStepId ?? null,
      issue.globalId ?? null, issue.name ?? null,
      issue.stepIds ?? null, issue.setStepId ?? null,
    ]);
    if (seenIssues.has(key)) return;
    seenIssues.add(key);
    ledgerIssues.push(issue);
  };
  for (const device of devices) {
    for (const issue of device.resolution.presence.issues) pushIssue(issue);
    for (const issue of device.issues) pushIssue(issue);
  }
  const relationRisks = ledgerIssues.filter(issue => [
    'dangling-relation-endpoint', 'malformed-relation', 'dangling-reference',
    'type-relation-target-not-type', 'property-relation-target-not-set',
    'containment-target-not-spatial', 'unparsed-statement',
    'duplicate-step-id', 'unparsed-arguments', 'missing-type-object',
    'partial-property-relation', 'partial-containment',
  ].includes(issue.code));
  const rosterRisks = ledgerIssues.filter(issue => [
    'unparsed-statement', 'duplicate-step-id', 'unparsed-arguments',
    'unterminated-string', 'unterminated-comment',
  ].includes(issue.code));
  const identityRisks = globalIdGroupsResult.map(group => ({
    code: 'duplicate-global-id',
    globalId: group.globalId,
    stepIds: group.stepIds,
    message: `GlobalId ${group.globalId} 重复`,
  }));
  const safeForRemoval = rosterRisks.length === 0 && relationRisks.length === 0;
  return {
    source,
    schema: model.schema,
    project: model.byType.get('IFCPROJECT')?.[0]
      ? {
        stepId: model.byType.get('IFCPROJECT')[0].id,
        globalId: stringValue(model.byType.get('IFCPROJECT')[0].values[0]),
        name: stringValue(model.byType.get('IFCPROJECT')[0].values[2]),
      }
      : null,
    unitContext: model.unitContext.summary(),
    devices,
    unreferencedPropertySets: model.relations.unreferencedSets,
    sameNameDevices: duplicateNames,
    duplicateGlobalIds: globalIdGroupsResult,
    issues: ledgerIssues,
    integrity: {
      complete: model.integrity.complete && ledgerIssues.length === 0,
      rosterComplete: rosterRisks.length === 0,
      relationsIntact: relationRisks.length === 0,
      identitiesUnique: identityRisks.length === 0,
      removable: safeForRemoval && identityRisks.length === 0,
      rosterRisks,
      relationRisks,
      identityRisks,
    },
    stats: {
      entities: model.entities.length,
      devices: devices.length,
      relations: model.relations.relations.length,
      propertyRelations: [...model.relations.propertySets.values()]
        .reduce((sum, entries) => sum + entries.length, 0),
      propertySets: (model.byType.get('IFCPROPERTYSET')?.length ?? 0) +
        (model.byType.get('IFCELEMENTQUANTITY')?.length ?? 0),
    },
  };
}

export function readLedger(text, options = {}) {
  const model = loadIfcModel(text);
  return buildDeviceLedger(model, options);
}

// -------------------------------------------------------------------------
// Comparison of two deliveries.

function fieldMap(device) {
  return new Map(device.fields.map(field => [field.key, field]));
}

// A re-expressed measurement (1200 mm versus 1.2 m) is the same physical
// value, and STEP ids/line numbers shift between files without changing the
// building.  Comparison therefore uses normalized values and GlobalIds;
// the original ids, raw text and formulas stay in the diff output as
// provenance.
function placementKey(value) {
  if (!value) return null;
  return JSON.stringify({
    status: value.status ?? null,
    containers: (value.containers ?? []).map(container => ({
      via: container.via,
      spatialGlobalId: container.spatialGlobalId,
      hops: (container.hops ?? []).map(hop => ({
        relationType: hop.relationType,
        from: hop.from?.globalId ?? null,
        to: hop.to?.globalId ?? null,
      })),
      path: (container.spatialPath ?? []).map(hop => ({
        relationType: hop.relationType ?? null,
        parentGlobalId: hop.parent?.globalId ?? null,
      })),
    })),
  });
}

function comparisonKey(field) {
  const value = field.value;
  if (!value) return JSON.stringify(value);
  if (field.category === 'placement') return placementKey(value);
  if (field.category === 'type') {
    return JSON.stringify({
      typeGlobalId: value.typeGlobalId,
      typeIfcType: value.typeIfcType,
      typeName: value.typeName,
    });
  }
  if (value.type === 'measure') {
    // When the unit chain is incomplete the raw number is the only evidence
    // available; compare it too so a change is surfaced (and then held as
    // uncertain) rather than disappearing.
    return JSON.stringify({
      type: 'measure',
      declaredType: value.declaredType,
      canonical: value.canonical,
      canonicalUnit: value.canonicalUnit,
      raw: value.unresolved ? value.raw : undefined,
      unresolved: value.unresolved,
    });
  }
  return JSON.stringify(value);
}

function changedFields(beforeDevice, afterDevice) {
  const before = fieldMap(beforeDevice);
  const after = fieldMap(afterDevice);
  const changes = [];
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const oldField = before.get(key);
    const newField = after.get(key);
    if (!oldField) {
      changes.push({
        kind: 'added',
        key,
        label: newField.label,
        category: newField.category,
        after: newField,
        before: null,
      });
      continue;
    }
    if (!newField) {
      changes.push({
        kind: 'removed',
        key,
        label: oldField.label,
        category: oldField.category,
        before: oldField,
        after: null,
      });
      continue;
    }
    if (comparisonKey(oldField) !== comparisonKey(newField)) {
      changes.push({
        kind: 'changed',
        key,
        label: newField.label,
        category: newField.category,
        before: oldField,
        after: newField,
      });
    }
  }
  return changes;
}

function deviceReference(device) {
  return {
    globalId: device.identity.globalId,
    name: device.identity.name,
    ifcType: device.identity.ifcType,
    stepId: device.identity.stepId,
    tag: device.identity.tag,
    placementStatus: device.placement.status,
    containers: device.placement.containers.map(entry => ({
      spatialGlobalId: entry.spatial?.globalId ?? null,
      spatialName: entry.spatial?.name ?? null,
      relationStepId: entry.relationStepId,
      via: entry.via,
    })),
    source: { kind: 'entity', stepId: device.identity.stepId, globalId: device.identity.globalId },
  };
}

function uncertaintyReasons(ledger) {
  return ledger.integrity.rosterRisks
    .concat(ledger.integrity.relationRisks)
    .concat(ledger.integrity.identityRisks)
    .map(issue => ({
      code: issue.code,
      message: issue.message,
      stepId: issue.stepId ?? null,
      stepIds: issue.stepIds ?? null,
      relationStepId: issue.relationStepId ?? null,
    }));
}

// Unresolved dependencies that belong to one device row.  Used when a
// difference straddles a value that could not be fully interpreted.
function deviceUnresolvedReasons(beforeDevice, afterDevice) {
  const collect = (device, side) => {
    const reasons = [];
    const seen = new Set();
    const push = (reason) => {
      const key = JSON.stringify([
        reason.code, reason.propertyStepId ?? null, reason.setStepId ?? null,
        reason.relationStepId ?? null,
      ]);
      if (seen.has(key)) return;
      seen.add(key);
      reasons.push(reason);
    };
    for (const source of device.propertySources) {
      for (const issue of source.issues) {
        push({
          side,
          code: issue.code,
          message: issue.message,
          missingStepId: issue.missingStepId ?? null,
          setStepId: issue.setStepId ?? source.setStepId,
          propertyStepId: issue.propertyStepId ?? null,
          relationStepId: issue.relationStepId ?? source.relationStepId ?? null,
        });
      }
      for (const observation of source.observations) {
        if (!unresolvedValue(observation.value)) continue;
        push({
          side,
          code: 'unresolved-property-value',
          message: `属性 #${observation.propertyStepId} 的数值未能完整解释`,
          propertyStepId: observation.propertyStepId,
          setStepId: source.setStepId,
          relationStepId: source.relationStepId ?? null,
        });
      }
    }
    for (const issue of device.issues) push({ side, ...issue });
    return reasons;
  };
  return [...collect(beforeDevice, 'before'), ...collect(afterDevice, 'after')];
}

// Dependency issues that make a device's own record incomplete in the
// delivery that still contained it.  Unit warnings are not included: a
// missing unit changes what a number means, not whether the device exists.
const EXISTENCE_RELEVANT_DEVICE_ISSUES = new Set([
  'missing-property-set',
  'missing-property',
  'partial-property-relation',
  'partial-containment',
  'missing-type-object',
  'type-relation-target-not-type',
  'property-relation-target-not-set',
  'containment-target-not-spatial',
  'unsupported-property-kind',
]);

// Risks that block calling a disappearing device "removed".  A broken
// relation elsewhere in the file does not block the claim for an unrelated
// device, but any incomplete dependency of this device does, in either
// delivery: the row that would have proved its absence was not fully read.
function removalRisks(ledger, device) {
  const risks = [];
  for (const issue of ledger.integrity.rosterRisks) risks.push(issue);
  for (const issue of ledger.integrity.identityRisks) risks.push(issue);
  for (const issue of device.issues) {
    if (!EXISTENCE_RELEVANT_DEVICE_ISSUES.has(issue.code)) continue;
    risks.push({
      ...issue,
      side: 'before',
      message: `设备 #${device.identity.stepId} 的依赖未解析：${issue.message}`,
    });
  }
  for (const issue of ledger.integrity.relationRisks) {
    if (isDanglingEndpoint(issue)) {
      // An endpoint with no surviving counterpart is anonymous: it could be
      // any device, including the one being checked.  A device-specific risk
      // exists when the device was the endpoint (by STEP id or GlobalId), or
      // when the same relationship existed in the earlier file.
      const deviceIsEndpoint = issue.missingStepId === device.identity.stepId;
      const deviceWasNamed = device.identity.globalId !== null &&
        (issue.missingGlobalId === device.identity.globalId ||
         issue.globalId === device.identity.globalId);
      // A missing related endpoint can be attributed through the surviving
      // objects of the same relationship: those GlobalIds are on the old
      // device's own relation network.  A missing relating endpoint hides a
      // group of related objects, so the previous relation id being retained
      // is the signal that it could have covered this device.
      const hiddenGroupCouldCover = issue.missingRole === 'relating' &&
        device.relations.some(relation => relation.relationStepId === issue.relationStepId);
      if (deviceIsEndpoint || deviceWasNamed || hiddenGroupCouldCover) risks.push(issue);
      continue;
    }
    // Other relationship damage (a set or type object that cannot be read)
    // can change a device's data but does not decide whether it exists.
  }
  return risks;
}

function isDanglingEndpoint(issue) {
  return issue.code === 'dangling-relation-endpoint';
}

// Compare two ledgers.  `removed` is asserted only when the later delivery's
// entity roster and relationship network are intact and all identities are
// unique.  Otherwise the difference is reported under `uncertain`, with the
// unresolved details, so a missing device is never claimed to have been
// demolished just because a relation failed to parse.
export function diffLedgers(before, after) {
  const beforeById = new Map();
  for (const device of before.devices) {
    if (device.identity.globalId) beforeById.set(device.identity.globalId, device);
  }
  const afterById = new Map();
  for (const device of after.devices) {
    if (device.identity.globalId) afterById.set(device.identity.globalId, device);
  }
  const reasonsAfter = uncertaintyReasons(after);
  const reasonsBefore = uncertaintyReasons(before);
  const added = [];
  const removed = [];
  const changed = [];
  const uncertain = { added: [], removed: [], changed: [] };
  const unchanged = [];
  for (const [globalId, device] of afterById) {
    if (!beforeById.has(globalId)) {
      const entry = deviceReference(device);
      // A device can only be called new when the earlier delivery's entity
      // roster and identities were complete and no unresolved dependency
      // could have been hiding the same GlobalId.
      // Devices are enumerated from STEP entities, so a damaged relation in
      // the earlier file cannot hide an entity from the roster.  An addition
      // is reported plainly once that roster is complete and no GlobalId is
      // ambiguous.  Removal is stricter (see below): there, a damaged
      // dependency must not be read as demolition.
      if (before.integrity.rosterComplete && before.integrity.identitiesUnique) {
        added.push(entry);
      } else {
        entry.reasons = reasonsBefore;
        entry.reason = '上一次交付的关系或身份不完整，无法确认这是新增设备';
        uncertain.added.push(entry);
      }
      continue;
    }
    const prior = beforeById.get(globalId);
    const differences = changedFields(prior, device);
    if (!differences.length) {
      unchanged.push(deviceReference(device));
      continue;
    }
    const entry = {
      globalId,
      name: device.identity.name,
      ifcType: device.identity.ifcType,
      beforeStepId: prior.identity.stepId,
      afterStepId: device.identity.stepId,
      beforeSource: { kind: 'entity', stepId: prior.identity.stepId, globalId },
      afterSource: { kind: 'entity', stepId: device.identity.stepId, globalId },
      changes: differences.map(difference => ({
        kind: difference.kind,
        key: difference.key,
        label: difference.label,
        category: difference.category ?? null,
        before: difference.before?.value ?? null,
        after: difference.after?.value ?? null,
        display: {
          before: difference.before?.display ?? null,
          after: difference.after?.display ?? null,
        },
        sources: {
          before: difference.before?.source ?? null,
          after: difference.after?.source ?? null,
        },
        unresolved: difference.before?.unresolved === true || difference.after?.unresolved === true,
      })),
    };
    if (entry.changes.some(change => change.unresolved)) {
      entry.reason = '差异两侧存在未解析的属性或单位，不能确认资料变化的含义';
      entry.reasons = deviceUnresolvedReasons(prior, device);
      uncertain.changed.push(entry);
    } else {
      changed.push(entry);
    }
  }
  for (const [globalId, device] of beforeById) {
    if (afterById.has(globalId)) continue;
    const entry = deviceReference(device);
    // A disappearance is not a removal unless the later delivery's roster
    // and identities are intact and no damaged relationship could have been
    // hiding this device.  `relevantRemovalRisks` narrows the check to the
    // relations and entities that could affect this particular device.
    const blocking = removalRisks(after, device);
    if (after.integrity.rosterComplete && after.integrity.identitiesUnique && blocking.length === 0) {
      removed.push(entry);
    } else {
      entry.reasons = blocking;
      entry.reason = '本次交付的关系或身份解析不完整，不能判定设备已从楼中拆除';
      uncertain.removed.push(entry);
    }
  }
  return {
    before: {
      source: before.source,
      devices: before.devices.length,
      removable: before.integrity.removable,
      rosterComplete: before.integrity.rosterComplete,
      issues: reasonsBefore,
    },
    after: {
      source: after.source,
      devices: after.devices.length,
      removable: after.integrity.removable,
      rosterComplete: after.integrity.rosterComplete,
      issues: reasonsAfter,
    },
    added,
    removed,
    changed,
    uncertain,
    unchanged: unchanged.length,
    summary: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      uncertainAdded: uncertain.added.length,
      uncertainRemoved: uncertain.removed.length,
      uncertainChanged: uncertain.changed.length,
      unchanged: unchanged.length,
    },
  };
}

// -------------------------------------------------------------------------
// Flat, line-oriented view for reviewing a ledger without loading the full
// JSON into a context window.  Each row keeps the source references, so a
// reviewer can jump back to the STEP statements.

export function ledgerRows(ledger, { deviceGlobalId = null } = {}) {
  const rows = [];
  for (const device of ledger.devices) {
    if (deviceGlobalId && device.identity.globalId !== deviceGlobalId) continue;
    for (const field of device.fields) {
      const relationIds = field.source?.relationStepId
        ? [field.source.relationStepId]
        : field.source?.relationStepIds ?? [];
      rows.push({
        globalId: device.identity.globalId,
        deviceStepId: device.identity.stepId,
        name: device.identity.name,
        tag: device.identity.tag,
        placement: device.placement.status,
        label: field.label,
        category: field.category,
        value: field.value,
        display: field.display,
        sourceKind: field.source?.kind ?? null,
        relationStepId: relationIds[0] ?? null,
        relationStepIds: relationIds,
        setStepId: field.source?.setStepId ?? null,
        propertyStepId: field.source?.propertyStepId ?? null,
        stepLine: field.source?.propertyStepLine ??
          field.source?.relationStepLine ??
          field.source?.stepLine ??
          null,
        unresolved: field.unresolved === true,
      });
    }
    for (const conflict of device.conflicts) {
      rows.push({
        globalId: device.identity.globalId,
        deviceStepId: device.identity.stepId,
        name: device.identity.name,
        placement: device.placement.status,
        label: conflict.propertyName,
        category: 'conflict',
        value: conflict.sources.map(source => source.valueToken),
        display: conflict.message,
        sourceKind: 'multiple',
        relationStepId: conflict.sources.map(source => source.relationStepId),
        setStepId: conflict.sources.map(source => source.setStepId),
        propertyStepId: conflict.sources.map(source => source.propertyStepId),
        stepLine: conflict.sources.map(source => source.stepLine),
        unresolved: true,
      });
    }
  }
  return rows;
}

// Compact index of devices, suitable for a large model where the full ledger
// should not be serialized.  Each row is enough to pick a device and then ask
// for its details; counts show where unresolved dependencies sit without
// expanding them.
export function deviceIndex(ledger) {
  return ledger.devices.map(device => ({
    globalId: device.identity.globalId,
    stepId: device.identity.stepId,
    name: device.identity.name,
    tag: device.identity.tag,
    ifcType: device.identity.ifcType,
    placement: device.placement.status,
    containers: device.placement.containers.map(entry => ({
      spatialGlobalId: entry.spatial?.globalId ?? null,
      spatialName: entry.spatial?.name ?? null,
      relationStepId: entry.relationStepId,
      via: entry.via,
    })),
    typeStepIds: device.typeDefinitions.entries.map(entry => entry.typeStepId),
    propertySourceCount: device.propertySources.length,
    conflictCount: device.conflicts.length,
    issueCodes: device.issues.map(issue => issue.code),
    resolution: device.resolution,
  }));
}
