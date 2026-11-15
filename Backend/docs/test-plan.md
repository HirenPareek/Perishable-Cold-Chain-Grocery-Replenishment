# Camunda 8 Execution Test Plan
## Project 20: Perishable Cold-Chain Grocery Replenishment

This document defines the automated and manual verification procedures for Milestone 1 BPMN models executing on **Camunda 8 (Zeebe engine)**. It details five core test scenarios covering the happy path, edge-cases, boundary timeouts, and failure paths.

---

## 1. Test Environment Setup & Prerequisites

1. **Camunda 8 Cluster**: Verified on local Camunda 8 Run cluster (`D:\Work\Camunda\c8run-8.10.0-alpha3`).
2. **Model Deployment Verification**:
   - `bpmn-models/forms/*.form` -> Deployed (Deployment Key: `2251799813758757`)
   - `bpmn-models/supplier-invoice-three-way-match.bpmn` -> Deployed (Process Definition Key: `2251799813758753`)
   - `bpmn-models/cold-chain-replenishment-main.bpmn` -> Deployed (Process Definition Key: `2251799813758760`)
   - `docs/start-payload.json` -> Initial Process Instance Created (Process Instance Key: `2251799813758761`)
3. **Connector Secrets Configured**: Ensure all keys in `.env.example` are set in the Camunda cluster connector secrets store.
4. **Mock API Services Running**: Endpoints matching `docs/mocks/` reachable by Camunda connectors.

---

## 2. Test Scenarios

### Test Case 1: Happy Path (Full Replenishment, Quotes Accepted, Normal Transit, 3-Way Match Success)

#### Description
Store manager submits replenishment request; all 3 suppliers respond to RFQs within timeout; lowest-priced supplier is issued a PO; delivery completes within SLA; final IoT telemetry confirms temperature was within limits (<= 8°C); goods are received in full; invoice perfectly matches PO; process ends with successful completion summary.

#### Execution Steps:
1. **Start Process Instance**:
   - Start instance of `coldChainReplenishment` using `docs/start-payload.json`.
2. **User Task: Review & Approve Replenishment Request**:
   - In Camunda Tasklist, claim task `Review & Approve Replenishment Request`.
   - Submit form with `requestApproved = true`.
3. **RFQ Multi-Instance Execution**:
   - Process sends 3 RFQ emails and enters `SubProcess_WaitForQuote` for each supplier (`SUP-A`, `SUP-B`, `SUP-C`).
   - Correlate messages in Camunda Operate / Zeebe CLI:
     - **Message 1**:
       - Name: `QuoteReceived`
       - Correlation Key: `"REQ-1001-SUP-A"`
       - Variables: `{"quotePrice": 3200}`
     - **Message 2**:
       - Name: `QuoteReceived`
       - Correlation Key: `"REQ-1001-SUP-B"`
       - Variables: `{"quotePrice": 3600}`
     - **Message 3**:
       - Name: `QuoteReceived`
       - Correlation Key: `"REQ-1001-SUP-C"`
       - Variables: `{"quotePrice": 4100}`
4. **Supplier Ranking & Sequential PO Dispatch**:
   - Script task selects `SUP-A` (`PO-REQ-1001-SUP-A`, amount: $3,200).
   - Sequential MI issues PO via REST POST to Supplier API and sends email confirmation.
5. **Shipment Fulfilment & Delivery Catch**:
   - Process enters `SubProcess_ColdChainTransit`.
   - Correlate delivery message:
     - Name: `ShipmentDelivered`
     - Correlation Key: `"PO-REQ-1001-SUP-A"`
6. **Telemetry Verification**:
   - REST connector GET returns max temperature 5.4°C (`<= 8°C`).
   - Gateway selects default path `Within Cold Range`.
7. **User Task: Confirm Goods Receipt**:
   - Claim task `Confirm Goods Receipt`.
   - Fill form: `receivedQty = 350`, `invoiceNumber = "INV-SUP-A-9001"`, `invoiceAmount = 3200`.
8. **Call Activity: Supplier Invoice Three-Way Match**:
   - Child process executes automatically:
     - `orderedQty` (350) == `receivedQty` (350).
     - `orderedAmount` (3200) == `invoiceAmount` (3200).
     - Status set to `"MATCHED"`.
9. **Final Summary**:
   - Main process receives `matchStatus = "MATCHED"`.
   - Sends confirmation email to `storeManagerEmail`.

#### Expected End State in Camunda Operate:
- Main Process: `COMPLETED` at `EndEvent_ReplenishmentCompleted`.
- Child Process: `COMPLETED` at `EndEvent_Matched`.
- Incident Count: 0.

---

### Test Case 2: No-Quote Escalation Path (All RFQs Timeout)

#### Description
Suppliers fail to submit quotes within the boundary timer window (`PT2M`). The gateway identifies 0 valid responses, triggers an urgent Slack alert to QA/Procurement, and terminates at the escalated end event.

#### Execution Steps:
1. **Start Process Instance** with `docs/start-payload.json`.
2. **User Task**: Approve request (`requestApproved = true`).
3. **Timer Expiration**:
   - Do **NOT** publish any `QuoteReceived` messages.
   - Wait for `BoundaryEvent_QuoteTimeout` (`PT2M`) to fire on all three instances.
   - Script tasks set `quote = {supplierId: ..., price: null, responded: false}`.
4. **Gateway Evaluation**:
   - Expression `=count(quotes[item.responded = true]) > 0` evaluates to `false`.
   - Default flow activates `Task_AlertNoQuotes`.
5. **Slack Connector Execution**:
   - Sends message to Slack channel `{{secrets.SLACK_QA_CHANNEL}}`:
     `"URGENT: No supplier quotes received for replenishment request REQ-1001 at store STORE-12. Escalating to Category Manager."`

#### Expected End State in Camunda Operate:
- Main Process: `COMPLETED` at `EndEvent_NoQuotesEscalated`.
- Active Tokens: 0.
- `selectedOrders` not evaluated; no purchase orders dispatched.

---

### Test Case 3: Live Temperature Excursion -> QA Rejection Path

#### Description
During transit, an IoT sensor on trailer detects a temperature spike above 8°C. A non-interrupting event sub-process triggers a real-time QA alert and task. QA inspects the telemetry and decides to reject the load. An Error End Event propagates an error to the parent transit sub-process, initiating a supplier dispute and marking the PO rejected.

#### Execution Steps:
1. **Start Process & Complete RFQ / PO steps** (as in Test Case 1).
2. **Transit Sub-Process Active**:
   - Process token is at `Event_ShipmentDelivered` inside `SubProcess_ColdChainTransit`.
3. **Publish Real-Time Excursion Message**:
   - Publish message to trigger Non-Interrupting Event Sub-Process:
     - Name: `TempExcursionDetected`
     - Correlation Key: `"PO-REQ-1001-SUP-A"`
4. **Event Sub-Process Execution**:
   - REST connector fetches excursion detail (`docs/mocks/iot-telemetry-mock.json`).
   - Slack connector posts alert to `{{secrets.SLACK_QA_CHANNEL}}`.
5. **User Task: QA Excursion Decision**:
   - Claim task `QA Excursion Decision`.
   - Select radio option `qaExcursionDecision = "REJECT"`.
   - Enter notes: `"Prolonged compressor failure; milk curdling risk high."`
   - Complete task.
6. **Error Propagation**:
   - Event sub-process ends with `EndEvent_ExcursionRejected` (`errorCode = "SHIPMENT_REJECTED"`).
   - Interrupting boundary event `BoundaryEvent_ShipmentRejected` on `SubProcess_ColdChainTransit` catches the error.
7. **Rejection Handling**:
   - Slack connector alerts QA of formal shipment rejection.
   - REST connector calls Supplier API POST `/orders/{poNumber}/reject`.
   - Script task records `shipmentResult.status = "REJECTED"`.
   - Instance ends at `EndEvent_ShipmentRejected`.
8. **Replenishment Summary**:
   - Gateway `Gateway_ShipmentResultsSummary` evaluates discrepancy expression.
   - Executes `Task_SendDiscrepancyEmail` notifying store manager of rejection.

#### Expected End State in Camunda Operate:
- Main Process: `COMPLETED` at `EndEvent_ReplenishmentCompleted`.
- Sub-process: Terminated via `BoundaryEvent_ShipmentRejected`.
- Incident Count: 0.

---

### Test Case 4: Delivery SLA Breach Path (Timer Boundary Event)

#### Description
The supplier's refrigerated delivery truck fails to arrive at the store loading dock within the agreed SLA window (`PT5M` demo / 48 hours production). The interrupting timer boundary event fires, alerts QA, notifies the supplier of contract breach, and terminates transit.

#### Execution Steps:
1. **Start Process & Complete Steps 1-4** (PO issued).
2. **Wait for SLA Timer**:
   - Token is waiting at `Event_ShipmentDelivered`.
   - Do **NOT** publish the `ShipmentDelivered` message.
   - Allow `BoundaryEvent_DeliveryTimer` (`PT5M`) to expire.
3. **Timer Triggering & Escalation**:
   - Boundary timer interrupts `SubProcess_ColdChainTransit`.
   - Slack connector executes `Task_SlackLateDelivery`:
     `"SLA BREACH: Shipment delivery for PO PO-REQ-1001-SUP-A is overdue."`
   - Email connector executes `Task_EmailSupplierLate`:
     Emails supplier detailing contractual breach.
   - Script task sets `shipmentResult.status = "LATE"`.
   - Token reaches `EndEvent_DeliveryLate`.
4. **Discrepancy Email**:
   - Top-level gateway routes to `Task_SendDiscrepancyEmail`.

#### Expected End State in Camunda Operate:
- Main Process: `COMPLETED` at `EndEvent_ReplenishmentCompleted`.
- Shipment Subprocess: Terminated through `EndEvent_DeliveryLate`.

---

### Test Case 5: Three-Way Match Mismatch -> AP Dispute Path

#### Description
Shipment arrives normally, but at goods receipt dock 10 cartons are damaged/short (ordered 350, received 340), and supplier invoice overbills ($3,400 vs $3,200). The automated 3-way match condition fails. AP Clerk performs manual review and issues a formal dispute.

#### Execution Steps:
1. **Complete Steps 1-6 of Test Case 1** (Goods delivered within cold range).
2. **User Task: Confirm Goods Receipt**:
   - Claim task `Confirm Goods Receipt`.
   - Enter mismatched data:
     - `receivedQty = 340` (Ordered: 350)
     - `invoiceNumber = "INV-ERR-8812"`
     - `invoiceAmount = 3400.00` (Ordered: 3200.00)
   - Submit form.
3. **Child Process Invocation**:
   - Main process invokes `supplierInvoiceThreeWayMatch` with explicit input mappings.
   - Script task `Task_EvaluateMatch` evaluates:
     `qtyMatched` = (340 = 350) -> `false`
     `matchToleranceMet` = (abs(3400 - 3200) <= 64) -> `false`
     `isMatch` -> `false`.
   - Gateway `Gateway_IsMatched` takes branch `Flow_MatchFailure`.
4. **User Task: AP Clerk Manual Review**:
   - Claim task `AP Clerk Manual Review` in child process.
   - Inspect variance fields displayed on form:
     - `quantityVariance = 10`
     - `amountVariance = 200.00`
   - Select decision `apDecision = "DISPUTE"`.
   - Enter notes: `"Short delivery and billing overage. Dispute logged with supplier."`
   - Submit form.
5. **Child Process Completion**:
   - Gateway routes to `Task_SetDisputed`.
   - Sets `matchStatus = "DISPUTED"`.
   - Ends at `EndEvent_Disputed`.
6. **Parent Process Reaction**:
   - Child variable `matchStatus` maps to `childMatchStatus` in parent.
   - Main process aggregates `shipmentResult = { ..., matchStatus: "DISPUTED" }`.
   - Evaluates `Gateway_ShipmentResultsSummary` -> routes to `Task_SendDiscrepancyEmail`.

#### Expected End State in Camunda Operate:
- Main Process: `COMPLETED` at `EndEvent_ReplenishmentCompleted`.
- Child Process: `COMPLETED` at `EndEvent_Disputed`.
- `childMatchStatus`: `"DISPUTED"`.
