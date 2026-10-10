/**
 * Regression tests for the Raft "Election Safety" property of ConsensusProtocol:
 * a node may cast at most ONE vote per term, so at most one leader can ever be
 * elected in a given term. The vote may only be forgotten when the term advances.
 */

import { ConsensusProtocol } from "@/party/mesh/ConsensusProtocol";

const IDS = ["A", "B", "C", "D", "E"];

describe("ConsensusProtocol one-vote-per-term safety", () => {
  let nodes: ConsensusProtocol[] = [];

  function cluster(ids: string[] = IDS): Record<string, ConsensusProtocol> {
    const map: Record<string, ConsensusProtocol> = {};
    for (const id of ids) {
      const node = new ConsensusProtocol(id, ids);
      nodes.push(node);
      map[id] = node;
    }
    return map;
  }

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    nodes.forEach((n) => n.destroy());
    nodes = [];
    jest.useRealTimers();
  });

  it("never elects two leaders in the same term (5-node split vote)", () => {
    const n = cluster();

    // A and B time out together and both campaign in term 1.
    n.A.startElection();
    n.B.startElection();

    // C and D vote for A -> A reaches the 3/5 quorum.
    for (const voter of ["C", "D"]) {
      const reply = n[voter].requestVote("A", 1);
      expect(reply.voteGranted).toBe(true);
      n.A.handleVoteResponse(voter, reply.term, reply.voteGranted);
    }
    expect(n.A.isLeader()).toBe(true);

    // A's first heartbeat reaches C (normal operation).
    n.C.appendEntries("A", 1, []);

    // B now asks C and E for votes in the SAME term.
    let granted = 0;
    for (const voter of ["C", "E"]) {
      const reply = n[voter].requestVote("B", 1);
      if (reply.voteGranted) granted++;
      n.B.handleVoteResponse(voter, reply.term, reply.voteGranted);
    }

    // C already voted for A in term 1, so only E can vote for B: B has 2/5.
    expect(granted).toBe(1);
    expect(n.B.isLeader()).toBe(false);
    const leadersInTerm1 = IDS.filter(
      (id) => n[id].isLeader() && n[id].getState().currentTerm === 1,
    );
    expect(leadersInTerm1).toEqual(["A"]);
  });

  it("keeps votedFor when a heartbeat from the same-term leader arrives", () => {
    const n = cluster();

    expect(n.C.requestVote("A", 1).voteGranted).toBe(true);
    n.C.appendEntries("A", 1, []);

    expect(n.C.getState().votedFor).toBe("A");
    expect(n.C.requestVote("B", 1).voteGranted).toBe(false);
  });

  it("still lets the same candidate re-request a vote (idempotent)", () => {
    const n = cluster();

    expect(n.C.requestVote("A", 1).voteGranted).toBe(true);
    n.C.appendEntries("A", 1, []);
    expect(n.C.requestVote("A", 1).voteGranted).toBe(true);
  });

  it("keeps a candidate's self-vote when it yields to a same-term leader", () => {
    const n = cluster();

    n.B.startElection(); // term 1, votedFor = B
    expect(n.B.appendEntries("A", 1, [])).toBe(true);

    expect(n.B.getRole()).toBe("follower");
    expect(n.B.getState().votedFor).toBe("B");
    expect(n.B.requestVote("C", 1).voteGranted).toBe(false);
  });

  it("keeps the vote when a leader steps down after losing its quorum lease", () => {
    const n = cluster(["A"]);

    n.A.startElection(); // single node: immediately leader of term 1
    expect(n.A.isLeader()).toBe(true);

    // Cluster grows to 5 nodes; the leader only has its own ack (1 < quorum 3).
    n.A.setClusterNodes(IDS);
    expect(n.A.getRole()).toBe("follower");
    expect(n.A.getState().currentTerm).toBe(1);

    // It already voted (for itself) in term 1, so it must refuse term-1 candidates.
    expect(n.A.getState().votedFor).toBe("A");
    expect(n.A.requestVote("B", 1).voteGranted).toBe(false);
  });

  it("still forgets the previous vote when the term advances", () => {
    const n = cluster();

    expect(n.C.requestVote("A", 1).voteGranted).toBe(true);

    // A newer term is a fresh election: voting for a different candidate is fine.
    const reply = n.C.requestVote("B", 2);
    expect(reply.voteGranted).toBe(true);
    expect(n.C.getState().currentTerm).toBe(2);
    expect(n.C.getState().votedFor).toBe("B");
  });

  it("clears votedFor when a heartbeat carries a newer term", () => {
    const n = cluster();

    expect(n.C.requestVote("A", 1).voteGranted).toBe(true);
    n.C.appendEntries("B", 2, []);

    expect(n.C.getState().currentTerm).toBe(2);
    expect(n.C.getState().votedFor).toBeNull();
    expect(n.C.requestVote("D", 2).voteGranted).toBe(true);
  });

  it("rejects stale-term vote requests and heartbeats", () => {
    const n = cluster();

    n.C.appendEntries("B", 3, []);
    expect(n.C.requestVote("A", 2).voteGranted).toBe(false);
    expect(n.C.appendEntries("A", 2, [])).toBe(false);
    expect(n.C.getState().currentTerm).toBe(3);
  });
});
