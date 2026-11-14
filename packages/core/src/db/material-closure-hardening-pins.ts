// Frozen only by the offline disposable-catalogue qualifier; never learned from a live home.
export interface MaterialClosureHardeningPins {
 version:'material-closure-hardening-v1';qualifiedBaseCommit:string;payloadSha256:string;
 predecessorProfileSha256:string;functions:Readonly<Record<string,string>>;
}
export const MATERIAL_CLOSURE_HARDENING_PINS:MaterialClosureHardeningPins={
  "version": "material-closure-hardening-v1",
  "qualifiedBaseCommit": "1fef3fc0cf17cc21b559396f481a2997f8feda61",
  "payloadSha256": "548a57924dc80927f133099f40686f516ec2a230cd8e60e1d80bb753a520bdbf",
  "predecessorProfileSha256": "99c5e637a9721e07a273d0a8d851423fde38c6f9647420968230d8dc92b7bbde",
  "functions": {
    "gov._candidate_input_manifest_v1(app.knowledge_candidates,bigint)": "b38402a91f3f94a7877a4a26e915cd2c2f35f4c993b74bf933eeaf5821c7742d",
    "sec.t_candidate_input_capture_v1()": "12bff38573d5092df011d63e282a709423dea4698249edc537cd180cc7b118d1"
  }
};
