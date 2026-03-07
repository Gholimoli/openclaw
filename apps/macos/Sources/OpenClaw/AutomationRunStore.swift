import Foundation
import Observation
import OpenClawProtocol

@MainActor
@Observable
final class AutomationRunStore {
    static let shared = AutomationRunStore()

    struct RunCard: Identifiable, Equatable {
        let id: String
        let repo: String
        let title: String
        let status: String
        let planner: String?
        let implementationCli: String
        let updatedAt: Date
    }

    struct ApprovalCard: Identifiable, Equatable {
        let id: String
        let agentId: String?
        let sessionKey: String?
        let command: String
        let ask: String?
        let expiresAt: Date
    }

    private(set) var recentRuns: [RunCard] = []
    private(set) var pendingApprovals: [ApprovalCard] = []

    func upsert(run: AutomationRun) {
        let card = RunCard(
            id: run.id,
            repo: run.repo,
            title: run.title,
            status: run.status,
            planner: run.plannerdisplayname ?? run.planneragentid,
            implementationCli: run.implementationusedcli ?? run.implementationcli,
            updatedAt: Date(timeIntervalSince1970: TimeInterval(run.updatedatms) / 1000))
        self.recentRuns.removeAll { $0.id == card.id }
        self.recentRuns.insert(card, at: 0)
        self.recentRuns.sort { $0.updatedAt > $1.updatedAt }
        if self.recentRuns.count > 6 {
            self.recentRuns = Array(self.recentRuns.prefix(6))
        }
    }

    func addApproval(
        id: String,
        agentId: String?,
        sessionKey: String?,
        command: String,
        ask: String?,
        expiresAtMs: Int)
    {
        let card = ApprovalCard(
            id: id,
            agentId: agentId,
            sessionKey: sessionKey,
            command: command,
            ask: ask,
            expiresAt: Date(timeIntervalSince1970: TimeInterval(expiresAtMs) / 1000))
        self.pendingApprovals.removeAll { $0.id == id }
        self.pendingApprovals.append(card)
        self.pruneApprovals()
        self.pendingApprovals.sort { $0.expiresAt < $1.expiresAt }
    }

    func resolveApproval(id: String) {
        self.pendingApprovals.removeAll { $0.id == id }
    }

    private func pruneApprovals(now: Date = Date()) {
        self.pendingApprovals.removeAll { $0.expiresAt <= now }
    }
}
