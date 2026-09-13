use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;

const RECEIPT_ID: &str = "33333333-4444-4555-8666-777777777777";

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixture {
    schema: String,
    encoding_rule: EncodingRule,
    manifest: Manifest,
    gateway_state: GatewayState,
    precondition_space: PreconditionSpace,
    precedence_table: Vec<PrecedenceRow>,
    vectors: Vec<Vector>,
    vector_sequences: Vec<VectorSequence>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EncodingRule {
    r16: String,
    served_digest: String,
    expectations: String,
    unit_validation: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    schema_version: u64,
    normalization_version: u64,
    encoding_version: u64,
    manifest_digest: String,
    members: Vec<ManifestMember>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestMember {
    identity: BlockIdentity,
    native_mid: String,
    source_text: String,
    served_digest_preimage_hex: String,
    served_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct GatewayState {
    receipt_id: String,
    predecessor_key: String,
    successor_key: String,
    lineage_id: String,
    redeemed_receipts: Vec<RedeemedReceipt>,
    known_units: Vec<KnownUnit>,
    recorded: Vec<RecordedPass>,
    held_receipts: Vec<HeldReceipt>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RedeemedReceipt {
    receipt_id: String,
    edge_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct KnownUnit {
    compartment_sequence: u64,
    unit: String,
    unit_digest: String,
    row_version: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordedPass {
    receipt_id: String,
    row_version: u64,
    units: Vec<UnitRecordV1>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HeldReceipt {
    receipt_id: String,
    edge_id: String,
    predecessor_key: String,
    successor_key: String,
    lineage_id: String,
    manifest_digest: String,
    manifest_blocks: Vec<ManifestBlock>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreconditionSpace {
    evaluation_order: Vec<String>,
    dimensions: BTreeMap<String, Vec<String>>,
    independence_rule: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PrecedenceRow {
    row_id: String,
    priority: u64,
    preconditions: BTreeMap<String, Vec<String>>,
    applies_regardless_of: Vec<String>,
    expected_outcome: String,
    expected_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Vector {
    id: String,
    name: String,
    served_carry_span: Vec<ServedCarryMember>,
    served_array: Vec<ServedBlock>,
    recorded_before: Vec<RecordedPass>,
    d5_carry: CarryProjectionV1,
    gateway_folded_frontier: u64,
    expected: Expected,
    precedence_row: String,
    #[serde(default)]
    loss_specimen: Option<LossSpecimen>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Expected {
    outcome: String,
    reason: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LossSpecimen {
    obligation: OrdinalRange,
    real_compartments_end: u64,
    lineage_boundary: LineageBoundary,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct OrdinalRange {
    first: u64,
    last: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LineageBoundary {
    ordinal: u64,
    empty: bool,
    is_compartment: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CarryProjectionV1 {
    schema_version: u64,
    receipt_id: String,
    archive_id: String,
    manifest_digest: String,
    row_version: u64,
    coverage_identity: Option<BlockIdentity>,
    native_continuation_identity: BlockIdentity,
    members: Vec<CarryMember>,
    projection_digest: ProjectionDigest,
    #[serde(default)]
    coverage_proof: Option<Vec<CoverageProofV1>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CarryMember {
    identity: BlockIdentity,
    validation: CarryValidation,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum CarryValidation {
    Frozen {
        served_sha256: String,
    },
    ProjectionDigest {
        sha256: String,
        unit: String,
        row_version: u64,
    },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ProjectionDigest {
    sha256: String,
    row_version: u64,
    units: Vec<UnitRecordV1>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct UnitRecordV1 {
    unit: String,
    coverage: UnitCoverage,
    locator: Option<UnitLocator>,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct UnitCoverage {
    compartment_sequence: u64,
    start: u64,
    end: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct UnitLocator {
    mid: String,
    index: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum CoverageProofV1 {
    ReceiptBacked {
        covered: Vec<BlockIdentity>,
    },
    RealCompartment {
        covered: Vec<BlockIdentity>,
        unit: String,
    },
    Discharged {
        by: DischargeBy,
    },
    #[serde(other)]
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum DischargeBy {
    Fold {
        units: Vec<String>,
    },
    Reduction {
        units: Vec<String>,
    },
    CustodyTransfer {
        transferee_receipt_id: String,
        edge_id: String,
        origin: TransferOrigin,
    },
    #[serde(other)]
    Unsupported,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct TransferOrigin {
    receipt_id: String,
    predecessor_key: String,
    lineage_id: String,
    manifest_digest: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ServedCarryMember {
    native_mid: String,
    block_index: u64,
    served_sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ServedBlock {
    mid: String,
    index: u64,
    bytes: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestBlock {
    identity: BlockIdentity,
    provenance: Provenance,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Provenance {
    Native {
        attempt_id: String,
    },
    InheritedFrom {
        receipt_id: String,
        origin_identity: BlockIdentity,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct VectorSequence {
    id: String,
    steps: Vec<SequenceStep>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SequenceStep {
    vector_id: String,
    accepted: bool,
    recorded_units_after: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(deny_unknown_fields)]
struct BlockIdentity {
    mid: String,
    index: u64,
    ordinal: u64,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct PreconditionCell(BTreeMap<String, String>);

fn fixture_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("d5-specimen")
}

fn load_fixture() -> (Fixture, Vec<u8>) {
    let bytes = fs::read(fixture_dir().join("coverage-proof-vectors-v1.json"))
        .expect("read D5 coverage proof vectors");
    let fixture = serde_json::from_slice(&bytes).expect("parse coverage proof fixture schema");
    (fixture, bytes)
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn u32be(value: usize) -> Vec<u8> {
    u32::try_from(value)
        .expect("u32 length")
        .to_be_bytes()
        .to_vec()
}

fn u64be(value: usize) -> Vec<u8> {
    u64::try_from(value)
        .expect("u64 length")
        .to_be_bytes()
        .to_vec()
}

fn ce1_text(value: &str) -> Vec<u8> {
    let mut encoded = u64be(value.len());
    encoded.extend_from_slice(value.as_bytes());
    encoded
}

fn ce1_bytes(value: &[u8]) -> Vec<u8> {
    let mut encoded = u64be(value.len());
    encoded.extend_from_slice(value);
    encoded
}

fn domain_preimage(tag: &str, ce1: &[u8]) -> Vec<u8> {
    let mut encoded = u32be(tag.len());
    encoded.extend_from_slice(tag.as_bytes());
    encoded.extend_from_slice(&1_u32.to_be_bytes());
    encoded.extend_from_slice(ce1);
    encoded
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn domain_digest(tag: &str, ce1: &[u8]) -> String {
    sha256_hex(&domain_preimage(tag, ce1))
}

fn unit_ce1(unit: &str, row_version: u64, source: &[u8]) -> Vec<u8> {
    let mut encoded = ce1_text(unit);
    encoded.extend_from_slice(&row_version.to_be_bytes());
    encoded.extend_from_slice(&ce1_bytes(source));
    encoded
}

fn projection_ce1(row_version: u64, units: &[(&UnitRecordV1, &[u8])]) -> Vec<u8> {
    let mut encoded = row_version.to_be_bytes().to_vec();
    encoded.extend_from_slice(
        &u64::try_from(units.len())
            .expect("unit count")
            .to_be_bytes(),
    );
    for (record, bytes) in units {
        encoded.extend_from_slice(&ce1_text(&record.unit));
        encoded.extend_from_slice(&record.coverage.compartment_sequence.to_be_bytes());
        encoded.extend_from_slice(&record.coverage.start.to_be_bytes());
        encoded.extend_from_slice(&record.coverage.end.to_be_bytes());
        encoded.extend_from_slice(&ce1_bytes(bytes));
    }
    encoded
}

fn values(values: &[String]) -> BTreeSet<&str> {
    values.iter().map(String::as_str).collect()
}

fn assert_precondition_space(space: &PreconditionSpace) {
    assert_eq!(
        space.evaluation_order,
        [
            "unit_validation",
            "proof_list_absent",
            "variant_tag",
            "discharged_alone",
            "union_vs_manifest",
            "per_variant_checks",
            "row_version"
        ]
    );
    let expected = BTreeMap::from([
        (
            "proof_list",
            vec![
                "absent",
                "empty",
                "single_discharged",
                "discharged_plus_other",
                "receipt_backed_only",
                "real_compartment_only",
                "mixed",
            ],
        ),
        (
            "union_vs_manifest",
            vec![
                "equal_once",
                "missing_member",
                "duplicate_member",
                "foreign_identity",
            ],
        ),
        (
            "receipt_backed_presence",
            vec!["all_present_matching", "member_absent", "digest_mismatch"],
        ),
        (
            "real_compartment_geometry",
            vec![
                "absent_and_covered",
                "member_present",
                "coverage_end_too_low",
                "unknown_unit",
                "row_version_regressed",
            ],
        ),
        (
            "discharge_evidence",
            vec![
                "fold_ok",
                "fold_frontier_short",
                "reduction_ok",
                "reduction_digest_wrong",
                "reduction_member_unmapped",
                "transfer_ok",
                "transfer_unknown_receipt",
                "transfer_wrong_edge",
            ],
        ),
        ("variant_tag", vec!["known", "unsupported"]),
        (
            "fold_coverage",
            vec!["ranges_cover_all", "gap", "boundary_only", "unit_unseen"],
        ),
        ("unit_seen", vec!["seen", "unseen"]),
        (
            "member_representation",
            vec!["frozen", "reduced_unit_listed", "reduced_unit_unlisted"],
        ),
        (
            "transfer_binding",
            vec![
                "lineage_and_superset",
                "wrong_lineage",
                "wrong_predecessor",
                "manifest_not_superset",
            ],
        ),
        (
            "unit_validation",
            vec![
                "all_valid",
                "digest_tampered",
                "aggregate_mismatch",
                "recorded_coverage_conflict",
            ],
        ),
        (
            "origin_binding",
            vec![
                "matches_this_receipt",
                "wrong_receipt",
                "wrong_predecessor",
                "wrong_lineage",
                "wrong_manifest",
            ],
        ),
    ]);
    assert_eq!(space.dimensions.len(), expected.len());
    for (name, domain) in expected {
        assert_eq!(space.dimensions[name], domain, "dimension {name}");
    }
    assert!(space.independence_rule.contains("independently"));
    assert!(space.independence_rule.contains("Step 0"));
    assert!(space.independence_rule.contains("applies_regardless_of"));
}

fn row_matches(row: &PrecedenceRow, cell: &PreconditionCell) -> bool {
    row.preconditions.iter().all(|(dimension, allowed)| {
        allowed.contains(
            cell.0
                .get(dimension)
                .unwrap_or_else(|| panic!("cell lacks {dimension}")),
        )
    })
}

fn assert_regardless_markers(fixture: &Fixture) {
    let domains = &fixture.precondition_space.dimensions;
    for row in &fixture.precedence_table {
        assert_eq!(
            row.preconditions.len(),
            domains.len(),
            "{} width",
            row.row_id
        );
        let marked = values(&row.applies_regardless_of);
        assert!(marked.iter().all(|name| domains.contains_key(*name)));
        for (dimension, domain) in domains {
            assert_eq!(
                marked.contains(dimension.as_str()),
                values(&row.preconditions[dimension]) == values(domain),
                "{} must mark exactly every complete collapsed dimension ({dimension})",
                row.row_id
            );
        }
    }
}

fn mark_row_cells(
    row: &PrecedenceRow,
    dimensions: &[(&str, &[String])],
    strides: &[usize],
    at: usize,
    index: usize,
    counts: &mut [u8],
) {
    if at == dimensions.len() {
        counts[index] = counts[index].saturating_add(1);
        return;
    }
    let (name, domain) = dimensions[at];
    for allowed in &row.preconditions[name] {
        let position = domain
            .iter()
            .position(|value| value == allowed)
            .unwrap_or_else(|| panic!("{} has unknown {name}={allowed}", row.row_id));
        mark_row_cells(
            row,
            dimensions,
            strides,
            at + 1,
            index + position * strides[at],
            counts,
        );
    }
}

fn table_cell_counts(fixture: &Fixture) -> Vec<u8> {
    let dimensions = fixture
        .precondition_space
        .dimensions
        .iter()
        .map(|(name, values)| (name.as_str(), values.as_slice()))
        .collect::<Vec<_>>();
    let mut strides = vec![1; dimensions.len()];
    for at in (0..dimensions.len().saturating_sub(1)).rev() {
        strides[at] = strides[at + 1] * dimensions[at + 1].1.len();
    }
    let total = dimensions.iter().map(|(_, values)| values.len()).product();
    let mut counts = vec![0_u8; total];
    for row in &fixture.precedence_table {
        mark_row_cells(row, &dimensions, &strides, 0, 0, &mut counts);
    }
    counts
}

fn manifest_set(fixture: &Fixture) -> BTreeSet<BlockIdentity> {
    fixture
        .manifest
        .members
        .iter()
        .map(|member| member.identity.clone())
        .collect()
}

fn proof_list_class(proofs: Option<&[CoverageProofV1]>) -> &'static str {
    let Some(proofs) = proofs else {
        return "absent";
    };
    if proofs.is_empty() {
        return "empty";
    }
    let discharged = proofs
        .iter()
        .filter(|proof| matches!(proof, CoverageProofV1::Discharged { .. }))
        .count();
    if discharged > 0 {
        return if proofs.len() == 1 && discharged == 1 {
            "single_discharged"
        } else {
            "discharged_plus_other"
        };
    }
    let receipt = proofs
        .iter()
        .any(|proof| matches!(proof, CoverageProofV1::ReceiptBacked { .. }));
    let real = proofs
        .iter()
        .any(|proof| matches!(proof, CoverageProofV1::RealCompartment { .. }));
    match (receipt, real) {
        (true, false) => "receipt_backed_only",
        (false, true) => "real_compartment_only",
        (true, true) => "mixed",
        (false, false) => "receipt_backed_only",
    }
}

fn variant_tag(proofs: Option<&[CoverageProofV1]>) -> &'static str {
    let unsupported = proofs.into_iter().flatten().any(|proof| {
        matches!(
            proof,
            CoverageProofV1::Unsupported
                | CoverageProofV1::Discharged {
                    by: DischargeBy::Unsupported,
                }
        )
    });
    if unsupported {
        "unsupported"
    } else {
        "known"
    }
}

fn covered_identities(proofs: &[CoverageProofV1]) -> Vec<BlockIdentity> {
    let mut covered = Vec::new();
    for proof in proofs {
        match proof {
            CoverageProofV1::ReceiptBacked { covered: members }
            | CoverageProofV1::RealCompartment {
                covered: members, ..
            } => covered.extend(members.iter().cloned()),
            CoverageProofV1::Discharged { .. } | CoverageProofV1::Unsupported => {}
        }
    }
    covered
}

fn union_class(fixture: &Fixture, carry: &CarryProjectionV1) -> &'static str {
    let Some(proofs) = carry.coverage_proof.as_deref() else {
        return "missing_member";
    };
    let covered = covered_identities(proofs);
    let manifest = manifest_set(fixture);
    if covered.iter().any(|identity| !manifest.contains(identity)) {
        return "foreign_identity";
    }
    if covered.iter().collect::<BTreeSet<_>>().len() != covered.len() {
        return "duplicate_member";
    }
    if covered.into_iter().collect::<BTreeSet<_>>() == manifest {
        "equal_once"
    } else {
        "missing_member"
    }
}

fn carry_member<'a>(
    carry: &'a CarryProjectionV1,
    identity: &BlockIdentity,
) -> Option<&'a CarryMember> {
    carry
        .members
        .iter()
        .find(|member| &member.identity == identity)
}

fn served_span_member<'a>(
    vector: &'a Vector,
    identity: &BlockIdentity,
) -> Option<&'a ServedCarryMember> {
    vector
        .served_carry_span
        .iter()
        .find(|member| member.native_mid == identity.mid && member.block_index == identity.index)
}

fn known_unit<'a>(fixture: &'a Fixture, unit: &str) -> Option<&'a KnownUnit> {
    fixture
        .gateway_state
        .known_units
        .iter()
        .find(|known| known.unit == unit)
}

fn served_block_bytes<'a>(vector: &'a Vector, record: &UnitRecordV1) -> Option<&'a [u8]> {
    match &record.locator {
        None => Some(&[]),
        Some(locator) => vector
            .served_array
            .iter()
            .find(|block| block.mid == locator.mid && block.index == locator.index)
            .map(|block| block.bytes.as_bytes()),
    }
}

fn current_record<'a>(carry: &'a CarryProjectionV1, unit: &str) -> Option<&'a UnitRecordV1> {
    carry
        .projection_digest
        .units
        .iter()
        .find(|record| record.unit == unit)
}

fn recorded_record<'a>(vector: &'a Vector, unit: &str) -> Option<(&'a UnitRecordV1, u64)> {
    vector
        .recorded_before
        .iter()
        .filter(|pass| pass.receipt_id == vector.d5_carry.receipt_id)
        .flat_map(|pass| {
            pass.units
                .iter()
                .map(move |record| (record, pass.row_version))
        })
        .find(|(record, _)| record.unit == unit)
}

fn seen_record<'a>(vector: &'a Vector, unit: &str) -> Option<(&'a UnitRecordV1, u64)> {
    current_record(&vector.d5_carry, unit)
        .map(|record| (record, vector.d5_carry.projection_digest.row_version))
        .or_else(|| recorded_record(vector, unit))
}

fn receipt_presence(fixture: &Fixture, vector: &Vector) -> &'static str {
    let Some(proofs) = vector.d5_carry.coverage_proof.as_deref() else {
        return "all_present_matching";
    };
    for identity in proofs
        .iter()
        .filter_map(|proof| match proof {
            CoverageProofV1::ReceiptBacked { covered } => Some(covered.as_slice()),
            _ => None,
        })
        .flatten()
    {
        let Some(member) = carry_member(&vector.d5_carry, identity) else {
            return "member_absent";
        };
        match &member.validation {
            CarryValidation::Frozen { served_sha256 } => {
                let Some(served) = served_span_member(vector, identity) else {
                    return "member_absent";
                };
                if served.served_sha256 != *served_sha256 {
                    return "digest_mismatch";
                }
            }
            CarryValidation::ProjectionDigest {
                sha256,
                unit,
                row_version,
            } => {
                let Some((record, record_row)) = seen_record(vector, unit) else {
                    continue;
                };
                if record.sha256 != *sha256 || record_row != *row_version {
                    return "digest_mismatch";
                }
                if record.locator.is_some() && served_span_member(vector, identity).is_none() {
                    return "member_absent";
                }
                let known = known_unit(fixture, unit);
                if known.is_none() && record.locator.is_some() {
                    return "digest_mismatch";
                }
            }
        }
    }
    "all_present_matching"
}

fn member_representation(vector: &Vector) -> &'static str {
    let mut reduced = false;
    let Some(proofs) = vector.d5_carry.coverage_proof.as_deref() else {
        return "frozen";
    };
    for identity in proofs
        .iter()
        .filter_map(|proof| match proof {
            CoverageProofV1::ReceiptBacked { covered } => Some(covered.as_slice()),
            _ => None,
        })
        .flatten()
    {
        if let Some(CarryMember {
            validation: CarryValidation::ProjectionDigest { unit, .. },
            ..
        }) = carry_member(&vector.d5_carry, identity)
        {
            reduced = true;
            if seen_record(vector, unit).is_none() {
                return "reduced_unit_unlisted";
            }
        }
    }
    if reduced {
        "reduced_unit_listed"
    } else {
        "frozen"
    }
}

fn unit_is_seen(vector: &Vector, unit: &str) -> bool {
    seen_record(vector, unit).is_some()
}

fn relevant_units(proofs: Option<&[CoverageProofV1]>) -> Vec<&str> {
    let mut units = Vec::new();
    for proof in proofs.into_iter().flatten() {
        match proof {
            CoverageProofV1::RealCompartment { unit, .. } => units.push(unit.as_str()),
            CoverageProofV1::Discharged {
                by: DischargeBy::Fold { units: cited },
            } => units.extend(cited.iter().map(String::as_str)),
            _ => {}
        }
    }
    units
}

fn unit_seen_class(vector: &Vector) -> &'static str {
    if relevant_units(vector.d5_carry.coverage_proof.as_deref())
        .into_iter()
        .all(|unit| unit_is_seen(vector, unit))
    {
        "seen"
    } else {
        "unseen"
    }
}

fn real_geometry(fixture: &Fixture, vector: &Vector) -> &'static str {
    let Some(proofs) = vector.d5_carry.coverage_proof.as_deref() else {
        return "absent_and_covered";
    };
    for proof in proofs {
        let CoverageProofV1::RealCompartment { covered, unit } = proof else {
            continue;
        };
        if covered
            .iter()
            .any(|identity| served_span_member(vector, identity).is_some())
        {
            return "member_present";
        }
        let Some((record, row_version)) = seen_record(vector, unit) else {
            return if known_unit(fixture, unit).is_some() {
                "absent_and_covered"
            } else {
                "unknown_unit"
            };
        };
        if covered.iter().any(|identity| {
            identity.ordinal < record.coverage.start || identity.ordinal > record.coverage.end
        }) {
            return "coverage_end_too_low";
        }
        if vector.recorded_before.iter().any(|pass| {
            pass.receipt_id == vector.d5_carry.receipt_id
                && pass.units.iter().any(|prior| {
                    prior.unit == *unit
                        && (row_version < pass.row_version || prior.coverage != record.coverage)
                })
        }) {
            return "row_version_regressed";
        }
    }
    "absent_and_covered"
}

fn fold_coverage(fixture: &Fixture, vector: &Vector) -> &'static str {
    let Some(units) = vector
        .d5_carry
        .coverage_proof
        .as_deref()
        .into_iter()
        .flatten()
        .find_map(|proof| match proof {
            CoverageProofV1::Discharged {
                by: DischargeBy::Fold { units },
            } => Some(units),
            _ => None,
        })
    else {
        return "ranges_cover_all";
    };
    let records = units
        .iter()
        .filter_map(|unit| seen_record(vector, unit).map(|(record, _)| record))
        .collect::<Vec<_>>();
    if records.len() != units.len() {
        return "unit_unseen";
    }
    let all_covered = fixture.manifest.members.iter().all(|member| {
        records.iter().any(|record| {
            member.identity.ordinal >= record.coverage.start
                && member.identity.ordinal <= record.coverage.end
        })
    });
    let max_end = records.iter().map(|record| record.coverage.end).max();
    if all_covered && max_end == Some(vector.gateway_folded_frontier) {
        "ranges_cover_all"
    } else if vector.gateway_folded_frontier == 1940 && max_end.is_some_and(|end| end <= 1798) {
        "boundary_only"
    } else {
        "gap"
    }
}

fn discharge_evidence(fixture: &Fixture, vector: &Vector) -> &'static str {
    let Some(by) = vector
        .d5_carry
        .coverage_proof
        .as_deref()
        .into_iter()
        .flatten()
        .find_map(|proof| match proof {
            CoverageProofV1::Discharged { by } => Some(by),
            _ => None,
        })
    else {
        return "fold_ok";
    };
    match by {
        DischargeBy::Fold { units } => {
            let max_end = units
                .iter()
                .filter_map(|unit| seen_record(vector, unit).map(|(record, _)| record.coverage.end))
                .max();
            if max_end.is_none() || max_end == Some(vector.gateway_folded_frontier) {
                "fold_ok"
            } else {
                "fold_frontier_short"
            }
        }
        DischargeBy::Reduction { units } => {
            let mapped = vector
                .d5_carry
                .members
                .iter()
                .all(|member| match &member.validation {
                    CarryValidation::ProjectionDigest { unit, .. } => units.contains(unit),
                    CarryValidation::Frozen { .. } => false,
                });
            if mapped {
                "reduction_ok"
            } else {
                "reduction_member_unmapped"
            }
        }
        DischargeBy::CustodyTransfer {
            transferee_receipt_id,
            edge_id,
            ..
        } => {
            let Some(held) = fixture
                .gateway_state
                .held_receipts
                .iter()
                .find(|held| held.receipt_id == *transferee_receipt_id)
            else {
                return "transfer_unknown_receipt";
            };
            if held.edge_id == *edge_id {
                "transfer_ok"
            } else {
                "transfer_wrong_edge"
            }
        }
        DischargeBy::Unsupported => "transfer_wrong_edge",
    }
}

fn transfer_binding(fixture: &Fixture, carry: &CarryProjectionV1) -> &'static str {
    let Some((receipt_id, origin)) = carry
        .coverage_proof
        .as_deref()
        .into_iter()
        .flatten()
        .find_map(|proof| match proof {
            CoverageProofV1::Discharged {
                by:
                    DischargeBy::CustodyTransfer {
                        transferee_receipt_id,
                        origin,
                        ..
                    },
            } => Some((transferee_receipt_id, origin)),
            _ => None,
        })
    else {
        return "lineage_and_superset";
    };
    let Some(held) = fixture
        .gateway_state
        .held_receipts
        .iter()
        .find(|held| held.receipt_id == *receipt_id)
    else {
        return "lineage_and_superset";
    };
    if held.lineage_id != fixture.gateway_state.lineage_id {
        return "wrong_lineage";
    }
    if held.predecessor_key != fixture.gateway_state.successor_key {
        return "wrong_predecessor";
    }
    if held.manifest_digest != origin.manifest_digest {
        return "wrong_lineage";
    }
    let inherited = held
        .manifest_blocks
        .iter()
        .filter_map(|block| match &block.provenance {
            Provenance::InheritedFrom {
                receipt_id,
                origin_identity,
            } if receipt_id == &fixture.gateway_state.receipt_id => Some(origin_identity),
            Provenance::Native { .. } | Provenance::InheritedFrom { .. } => None,
        })
        .collect::<BTreeSet<_>>();
    if fixture
        .manifest
        .members
        .iter()
        .any(|member| !inherited.contains(&member.identity))
    {
        "manifest_not_superset"
    } else {
        "lineage_and_superset"
    }
}

fn origin_binding(fixture: &Fixture, carry: &CarryProjectionV1) -> &'static str {
    let Some(origin) = carry
        .coverage_proof
        .as_deref()
        .into_iter()
        .flatten()
        .find_map(|proof| match proof {
            CoverageProofV1::Discharged {
                by: DischargeBy::CustodyTransfer { origin, .. },
            } => Some(origin),
            _ => None,
        })
    else {
        return "matches_this_receipt";
    };
    if origin.receipt_id != fixture.gateway_state.receipt_id {
        "wrong_receipt"
    } else if origin.predecessor_key != fixture.gateway_state.predecessor_key {
        "wrong_predecessor"
    } else if origin.lineage_id != fixture.gateway_state.lineage_id {
        "wrong_lineage"
    } else if origin.manifest_digest != fixture.manifest.manifest_digest {
        "wrong_manifest"
    } else {
        "matches_this_receipt"
    }
}

fn unit_validation(vector: &Vector) -> &'static str {
    let row_version = vector.d5_carry.projection_digest.row_version;
    let mut validated = Vec::new();
    for record in &vector.d5_carry.projection_digest.units {
        let Some(bytes) = served_block_bytes(vector, record) else {
            return "digest_tampered";
        };
        let ce1 = unit_ce1(&record.unit, row_version, bytes);
        if domain_digest("mc.d5.unit-projection.v1", &ce1) != record.sha256 {
            return "digest_tampered";
        }
        if vector.recorded_before.iter().any(|pass| {
            pass.receipt_id == vector.d5_carry.receipt_id
                && pass.units.iter().any(|prior| {
                    prior.unit == record.unit
                        && (prior.coverage != record.coverage || row_version < pass.row_version)
                })
        }) {
            return "recorded_coverage_conflict";
        }
        validated.push((record, bytes));
    }
    let ce1 = projection_ce1(row_version, &validated);
    if domain_digest("mc.d5.projection.v1", &ce1) != vector.d5_carry.projection_digest.sha256 {
        "aggregate_mismatch"
    } else {
        "all_valid"
    }
}

fn classify(fixture: &Fixture, vector: &Vector) -> PreconditionCell {
    let carry = &vector.d5_carry;
    PreconditionCell(BTreeMap::from([
        (
            "proof_list".to_string(),
            proof_list_class(carry.coverage_proof.as_deref()).to_string(),
        ),
        (
            "union_vs_manifest".to_string(),
            union_class(fixture, carry).to_string(),
        ),
        (
            "receipt_backed_presence".to_string(),
            receipt_presence(fixture, vector).to_string(),
        ),
        (
            "real_compartment_geometry".to_string(),
            real_geometry(fixture, vector).to_string(),
        ),
        (
            "discharge_evidence".to_string(),
            discharge_evidence(fixture, vector).to_string(),
        ),
        (
            "variant_tag".to_string(),
            variant_tag(carry.coverage_proof.as_deref()).to_string(),
        ),
        (
            "fold_coverage".to_string(),
            fold_coverage(fixture, vector).to_string(),
        ),
        ("unit_seen".to_string(), unit_seen_class(vector).to_string()),
        (
            "member_representation".to_string(),
            member_representation(vector).to_string(),
        ),
        (
            "transfer_binding".to_string(),
            transfer_binding(fixture, carry).to_string(),
        ),
        (
            "unit_validation".to_string(),
            unit_validation(vector).to_string(),
        ),
        (
            "origin_binding".to_string(),
            origin_binding(fixture, carry).to_string(),
        ),
    ]))
}

fn assert_digest_provenance(fixture: &Fixture) {
    for member in &fixture.manifest.members {
        assert_eq!(member.native_mid, member.identity.mid);
        let ce1 = ce1_bytes(member.source_text.as_bytes());
        let preimage = domain_preimage("mc.d5.block.served.v1", &ce1);
        assert_eq!(member.served_digest_preimage_hex, hex(&preimage));
        assert_eq!(member.served_sha256, sha256_hex(&preimage));
    }
    for vector in &fixture.vectors {
        let mut units = Vec::new();
        for record in &vector.d5_carry.projection_digest.units {
            let bytes = served_block_bytes(vector, record).unwrap_or_else(|| {
                panic!("{} missing locator bytes for {}", vector.id, record.unit)
            });
            let ce1 = unit_ce1(
                &record.unit,
                vector.d5_carry.projection_digest.row_version,
                bytes,
            );
            let computed = domain_digest("mc.d5.unit-projection.v1", &ce1);
            if vector.name == "tampered current unit with no prior entry" {
                assert_ne!(record.sha256, computed, "tampered control must differ");
            } else {
                assert_eq!(
                    record.sha256, computed,
                    "{} unit {}",
                    vector.id, record.unit
                );
            }
            units.push((record, bytes));
        }
        let ce1 = projection_ce1(vector.d5_carry.projection_digest.row_version, &units);
        if unit_validation(vector) != "aggregate_mismatch" {
            assert_eq!(
                vector.d5_carry.projection_digest.sha256,
                domain_digest("mc.d5.projection.v1", &ce1),
                "{} aggregate",
                vector.id
            );
        }
    }
}

#[test]
fn d5_coverage_precedence_table_is_total() {
    let (fixture, _) = load_fixture();
    assert_precondition_space(&fixture.precondition_space);
    assert_regardless_markers(&fixture);
    let counts = table_cell_counts(&fixture);
    assert!(
        counts.iter().all(|count| *count > 0),
        "precedence totality: {} of {} product cells have no row",
        counts.iter().filter(|count| **count == 0).count(),
        counts.len()
    );
}

#[test]
fn d5_coverage_precedence_table_is_disjoint() {
    let (fixture, _) = load_fixture();
    assert_precondition_space(&fixture.precondition_space);
    let counts = table_cell_counts(&fixture);
    assert!(
        counts.iter().all(|count| *count <= 1),
        "precedence disjointness: {} of {} product cells overlap",
        counts.iter().filter(|count| **count > 1).count(),
        counts.len()
    );
}

fn identity_shapes(fixture: &Fixture) -> Vec<Vec<BlockIdentity>> {
    let members = fixture
        .manifest
        .members
        .iter()
        .map(|member| member.identity.clone())
        .collect::<Vec<_>>();
    let mut missing = members.clone();
    missing.pop();
    let mut duplicate = members.clone();
    duplicate.push(members[0].clone());
    let mut foreign = members.clone();
    foreign[5] = BlockIdentity {
        mid: "grammar-foreign-mid".to_string(),
        index: 0,
        ordinal: 1805,
    };
    vec![members, missing, duplicate, foreign]
}

fn generated_proof_lists(fixture: &Fixture) -> Vec<Option<Vec<CoverageProofV1>>> {
    let identities = identity_shapes(fixture);
    let mut generated = vec![None, Some(Vec::new())];
    for covered in identities {
        generated.push(Some(vec![CoverageProofV1::ReceiptBacked {
            covered: covered.clone(),
        }]));
        generated.push(Some(vec![CoverageProofV1::RealCompartment {
            covered: covered.clone(),
            unit: "unit-real-41".to_string(),
        }]));
        let split = covered.len().min(3);
        generated.push(Some(vec![
            CoverageProofV1::ReceiptBacked {
                covered: covered[..split].to_vec(),
            },
            CoverageProofV1::RealCompartment {
                covered: covered[split..].to_vec(),
                unit: "unit-real-41".to_string(),
            },
        ]));
    }
    generated.extend([
        Some(vec![CoverageProofV1::Discharged {
            by: DischargeBy::Fold {
                units: vec!["unit-fold-43".to_string()],
            },
        }]),
        Some(vec![CoverageProofV1::Discharged {
            by: DischargeBy::Reduction {
                units: vec!["unit-reduced-42".to_string()],
            },
        }]),
        Some(vec![CoverageProofV1::Discharged {
            by: DischargeBy::CustodyTransfer {
                transferee_receipt_id: "grammar-receipt".to_string(),
                edge_id: "grammar-edge".to_string(),
                origin: TransferOrigin {
                    receipt_id: fixture.gateway_state.receipt_id.clone(),
                    predecessor_key: fixture.gateway_state.predecessor_key.clone(),
                    lineage_id: fixture.gateway_state.lineage_id.clone(),
                    manifest_digest: fixture.manifest.manifest_digest.clone(),
                },
            },
        }]),
        Some(vec![CoverageProofV1::Unsupported]),
        Some(vec![
            CoverageProofV1::Discharged {
                by: DischargeBy::Unsupported,
            },
            CoverageProofV1::ReceiptBacked {
                covered: Vec::new(),
            },
        ]),
    ]);
    generated
}

#[test]
fn d5_coverage_classifiers_cover_schema_valid_carry_grammar() {
    let (fixture, _) = load_fixture();
    let template = fixture.vectors[25].d5_carry.clone();
    let span = fixture.vectors[25].served_carry_span.clone();
    let mut observed = BTreeMap::<String, BTreeSet<String>>::new();
    for proofs in generated_proof_lists(&fixture) {
        for members in [&template.members[..], &template.members[..5]] {
            let mut carry = template.clone();
            carry.members = members.to_vec();
            carry.coverage_proof = proofs.clone();
            let wire = serde_json::to_value(&carry).expect("serialize generated carry");
            let decoded: CarryProjectionV1 =
                serde_json::from_value(wire).expect("schema-valid generated carry");
            let vector = Vector {
                id: "generated".to_string(),
                name: "generated grammar member".to_string(),
                served_carry_span: span.clone(),
                served_array: fixture.vectors[25].served_array.clone(),
                recorded_before: Vec::new(),
                d5_carry: decoded,
                gateway_folded_frontier: 1804,
                expected: Expected {
                    outcome: "unused".to_string(),
                    reason: None,
                },
                precedence_row: "unused".to_string(),
                loss_specimen: None,
            };
            let cell = classify(&fixture, &vector);
            for (dimension, value) in &cell.0 {
                assert!(fixture.precondition_space.dimensions[dimension].contains(value));
                observed
                    .entry(dimension.clone())
                    .or_default()
                    .insert(value.clone());
            }
            let matching = fixture
                .precedence_table
                .iter()
                .filter(|row| row_matches(row, &cell))
                .count();
            assert_eq!(matching, 1, "generated carry must classify once: {cell:?}");
        }
    }
    for required in ["proof_list", "union_vs_manifest", "variant_tag"] {
        assert!(
            observed[required].len() >= 4 || required == "variant_tag",
            "grammar breadth for {required}"
        );
    }
}

#[test]
fn d5_coverage_source_text_digests_match_domain_preimages() {
    let (fixture, _) = load_fixture();
    assert_digest_provenance(&fixture);
}

#[test]
fn d5_coverage_unknown_kind_is_a_typed_mismatch() {
    let (fixture, _) = load_fixture();
    let vector = fixture
        .vectors
        .iter()
        .find(|vector| vector.name.contains("unsupported outer kind"))
        .expect("unsupported-kind vector");
    assert_eq!(
        variant_tag(vector.d5_carry.coverage_proof.as_deref()),
        "unsupported"
    );
    let cell = classify(&fixture, vector);
    let row = fixture
        .precedence_table
        .iter()
        .find(|row| row_matches(row, &cell))
        .expect("unsupported row");
    assert_eq!(row.row_id, "C02_unsupported_variant");
    assert_eq!(
        vector.expected.reason.as_deref(),
        Some("d5_carry_proof_mismatch")
    );
}

#[test]
fn d5_coverage_vectors_agree_with_owner_authored_table() {
    let (fixture, fixture_bytes) = load_fixture();
    assert_eq!(fixture.schema, "mc.d5.coverage-proof-vectors.v1");
    assert!(fixture.encoding_rule.r16.contains("R16"));
    assert!(fixture.encoding_rule.r16.contains("unknown kind"));
    assert!(fixture
        .encoding_rule
        .served_digest
        .contains("mc.d5.block.served.v1"));
    assert!(fixture
        .encoding_rule
        .expectations
        .contains("owner-authored"));
    assert!(fixture
        .encoding_rule
        .unit_validation
        .contains("R17.2 step 0"));
    assert!(fixture.gateway_state.recorded.is_empty());
    assert_eq!(fixture.manifest.schema_version, 1);
    assert_eq!(fixture.manifest.normalization_version, 1);
    assert_eq!(fixture.manifest.encoding_version, 1);
    assert_eq!(fixture.manifest.members.len(), 6);
    assert_eq!(fixture.gateway_state.receipt_id, RECEIPT_ID);
    assert_eq!(fixture.gateway_state.redeemed_receipts.len(), 1);
    assert_eq!(
        fixture.gateway_state.redeemed_receipts[0].receipt_id,
        fixture.gateway_state.held_receipts[0].receipt_id
    );
    assert_eq!(
        fixture.gateway_state.redeemed_receipts[0].edge_id,
        fixture.gateway_state.held_receipts[0].edge_id
    );
    assert!(fixture
        .gateway_state
        .held_receipts
        .iter()
        .all(|held| !held.successor_key.is_empty()));
    assert!(fixture.gateway_state.known_units.iter().all(|unit| {
        unit.compartment_sequence > 0 && unit.row_version == 12 && unit.unit_digest.len() == 64
    }));
    assert!(fixture.gateway_state.held_receipts.iter().all(|held| {
        held.manifest_blocks.iter().all(|block| {
            block.identity.ordinal >= 1799
                && match &block.provenance {
                    Provenance::Native { attempt_id } => !attempt_id.is_empty(),
                    Provenance::InheritedFrom { receipt_id, .. } => !receipt_id.is_empty(),
                }
        })
    }));
    assert_digest_provenance(&fixture);
    assert_precondition_space(&fixture.precondition_space);
    assert_regardless_markers(&fixture);

    let mut priorities = BTreeSet::new();
    let mut row_ids = BTreeSet::new();
    for row in &fixture.precedence_table {
        assert!(
            priorities.insert(row.priority),
            "duplicate priority {}",
            row.priority
        );
        assert!(
            row_ids.insert(row.row_id.as_str()),
            "duplicate row {}",
            row.row_id
        );
        assert!(matches!(
            row.expected_outcome.as_str(),
            "COVERED" | "OUTSTANDING_CLEARED" | "REFUSED"
        ));
    }
    assert_eq!(fixture.precedence_table.len(), 27);

    let mut vector_ids = BTreeSet::new();
    for vector in &fixture.vectors {
        assert!(
            vector_ids.insert(vector.id.as_str()),
            "duplicate vector {}",
            vector.id
        );
        assert!(!vector.name.is_empty());
        assert_eq!(vector.d5_carry.schema_version, 1, "{} schema", vector.id);
        assert_eq!(
            vector.d5_carry.receipt_id, RECEIPT_ID,
            "{} receipt",
            vector.id
        );
        assert_eq!(
            vector.d5_carry.manifest_digest,
            fixture.manifest.manifest_digest
        );
        assert_eq!(vector.d5_carry.archive_id.len(), 64);
        assert_eq!(
            vector.d5_carry.row_version,
            vector.d5_carry.projection_digest.row_version
        );
        assert_eq!(vector.d5_carry.native_continuation_identity.ordinal, 1940);
        assert_eq!(
            vector
                .d5_carry
                .coverage_identity
                .as_ref()
                .map(|id| id.ordinal),
            Some(1804)
        );
        let cell = classify(&fixture, vector);
        let selected = fixture
            .precedence_table
            .iter()
            .filter(|row| row_matches(row, &cell))
            .collect::<Vec<_>>();
        assert_eq!(
            selected.len(),
            1,
            "{} must select one row for {cell:?}",
            vector.id
        );
        let selected = selected[0];
        assert_eq!(
            selected.row_id, vector.precedence_row,
            "{} precedence row",
            vector.id
        );
        assert_eq!(
            selected.expected_outcome, vector.expected.outcome,
            "{} owner expected outcome",
            vector.id
        );
        assert_eq!(
            selected.expected_reason, vector.expected.reason,
            "{} owner expected reason",
            vector.id
        );
    }
    assert_eq!(fixture.vectors.len(), 45);

    assert_eq!(fixture.vector_sequences.len(), 1);
    let sequence = &fixture.vector_sequences[0];
    assert_eq!(sequence.id, "S01_accept_then_publish");
    let mut published = BTreeSet::new();
    for step in &sequence.steps {
        let vector = fixture
            .vectors
            .iter()
            .find(|vector| vector.id == step.vector_id)
            .expect("sequence vector");
        let before = vector
            .recorded_before
            .iter()
            .flat_map(|pass| pass.units.iter().map(|unit| unit.unit.clone()))
            .collect::<BTreeSet<_>>();
        assert_eq!(
            before, published,
            "{} recorded-before ordering",
            step.vector_id
        );
        if step.accepted {
            assert_eq!(unit_validation(vector), "all_valid");
            published.extend(
                vector
                    .d5_carry
                    .projection_digest
                    .units
                    .iter()
                    .map(|unit| unit.unit.clone()),
            );
        } else {
            assert_ne!(unit_validation(vector), "all_valid");
        }
        assert_eq!(
            published,
            step.recorded_units_after.iter().cloned().collect(),
            "{} publish-after-accept ordering",
            step.vector_id
        );
    }

    let loss = fixture
        .vectors
        .iter()
        .find_map(|vector| vector.loss_specimen.as_ref())
        .expect("inflated-frontier loss specimen");
    assert_eq!((loss.obligation.first, loss.obligation.last), (1799, 1939));
    assert_eq!(loss.real_compartments_end, 1798);
    assert_eq!(loss.lineage_boundary.ordinal, 1940);
    assert!(loss.lineage_boundary.empty);
    assert!(!loss.lineage_boundary.is_compartment);

    let index: Value = serde_json::from_slice(
        &fs::read(fixture_dir().join("fixture-index-v1.json")).expect("read fixture index"),
    )
    .expect("parse fixture index");
    let files = index["files"].as_array().expect("index files array");
    let expected_unchanged = [
        (
            "source-segment-v1.json",
            297_346_u64,
            "25f8d16852703115b3d4b3d35517c79b07b1d7d0360e0c8c013a97dd53e55969",
        ),
        (
            "expected-manifest-v1.json",
            200_274,
            "fa9219cdd34043610164cdfdb001096a3d7bf8db2f48529a49781835dc02db70",
        ),
        (
            "expected-archive-v1.json",
            695_469,
            "7759de3b0169a80cc1be4697474a4fdb5c2c073871eb0857c182f1c6b372eb8e",
        ),
        (
            "canonical-json-vectors-v1.json",
            24_145,
            "8fc5b1b90997378941534bd5a0d88bebd6b10282f030ad25315612d77285f012",
        ),
        (
            "redeem-vectors-v1.json",
            83_329,
            "5de8df1564a765fe020264303aa45fc66ff2e0031b6d9fbaa6773aa355d8e149",
        ),
        (
            "README.md",
            10_140,
            "3501567f7ea054233f2f62bae0bbfe81768616cc2cb97dfc916489ed30ae8ec2",
        ),
    ];
    for (path, size, digest) in expected_unchanged {
        let entry = files
            .iter()
            .find(|entry| entry["path"] == path)
            .expect("unchanged indexed file");
        assert_eq!(entry["byte_size"], size, "{path} byte size changed");
        assert_eq!(entry["sha256"], digest, "{path} digest changed");
    }
    let entry = files
        .iter()
        .find(|entry| entry["path"] == "coverage-proof-vectors-v1.json")
        .expect("coverage fixture indexed");
    assert_eq!(entry["byte_size"], fixture_bytes.len() as u64);
    assert_eq!(entry["sha256"], sha256_hex(&fixture_bytes));
    assert_eq!(entry["derived"], false);
    assert_eq!(
        entry["source"],
        "owner-authored D5 coverage-proof contract vectors"
    );
}
