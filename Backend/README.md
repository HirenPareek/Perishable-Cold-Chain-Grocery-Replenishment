# Project 20: Perishable Cold-Chain Grocery Replenishment
### Academic Milestone 1: BPMN 2.0 Design and Executable Camunda 8 Architecture

Inspired by automated e-grocery supply chains (Ocado, Carrefour), this project delivers an executable **Camunda 8 (Zeebe)** workflow solution for perishable cold-chain grocery replenishment. It orchestrates parallel supplier RFQs, price-ranked sequential purchase order dispatches, real-time IoT temperature excursion tracking with non-interrupting event sub-processes, delivery SLA boundary timers, and automated three-way invoice matching via reusable Call Activities.

---

## 1. Technology Stack

- **Workflow Orchestration Engine**: Camunda 8 (Zeebe 8.5+)
- **Process Modeling Standard**: BPMN 2.0 (ISO/IEC 19510:2013) with BPMN DI visual interchange
- **Data Modeling & Expression Language**: FEEL (Friendly Enough Expression Language)
- **Forms Framework**: Camunda Forms Schema (v16)
- **Integration Framework**: Camunda 8 Outbound Connectors (REST / HTTP Connector, SMTP Email Connector, Slack Outbound Connector)
- **Mock Services & Contracts**: WireMock / JSON REST API payload contracts

---

## 2. System Architecture

The replenishment workflow coordinates store managers, regional dairy/produce suppliers, quality assurance teams, IoT tracking devices, and accounts payable clerks across distributed event lifecycles.

```mermaid
flowchart TD
    subgraph ClientAndStore ["Store Level"]
        Start([Start: Replenishment Request]) --> TaskReview[User Task: Review & Approve Request]
        TaskReview --> GwApprove{Approved?}
        GwApprove -- "No" --> EndRejected([End: Request Rejected])
    end

    subgraph RFQPhase ["Quotation Phase (Parallel Multi-Instance)"]
        GwApprove -- "Yes (Default)" --> SubRFQ[[Parallel MI: RFQ per Supplier]]
        SubRFQ --> TaskEmailRFQ[Email Connector: Send RFQ to Supplier]
        TaskEmailRFQ --> WaitSub[[Wait Sub-Process]]
        WaitSub --> MsgCatch[Catch Message: Quote Received]
        WaitSub -. "Boundary Timer (PT2M)" .-> SetTimeoutQuote[Record Timed-Out Quote]
        MsgCatch --> SetRecQuote[Record Received Quote]
        SetTimeoutQuote --> JoinQuote[Join Outcomes]
        SetRecQuote --> JoinQuote
    end

    subgraph EvaluationPhase ["Supplier Selection & PO Dispatch"]
        JoinQuote --> GwAnyQuote{Any Valid Quotes?}
        GwAnyQuote -- "No (Default)" --> SlackNoQuotes[Slack Connector: Alert QA] --> EndEscalate([End: No Quotes Escalated])
        GwAnyQuote -- "Quotes > 0" --> ScriptRank[FEEL: Rank by Price & Apply Budget Cap]
        ScriptRank --> SubSeqPO[[Sequential MI: Issue Purchase Orders]]
        SubSeqPO --> RestPO[REST Connector: POST PO to Supplier API]
        RestPO --> EmailPO[Email Connector: PO Confirmation]
        EmailPO --> SetPOResult[Set PO Result Object]
    end

    subgraph TransitPhase ["Cold-Chain Transit & QA (Parallel MI)"]
        SetPOResult --> SubShipment[[Parallel MI: Shipment Fulfilment]]
        SubShipment --> SubTransit[[Sub-Process: Cold-Chain Transit]]
        
        SubTransit -. "Boundary Timer: Delivery SLA (PT5M)" .-> AlertLate[Slack & Email SLA Breach] --> EndLate([End: Delivery Late])
        SubTransit -. "Boundary Error: SHIPMENT_REJECTED" .-> AlertReject[Slack & REST Mark PO Rejected] --> EndRejectShipment([End: Shipment Rejected])

        subgraph InTransitExecution ["Inside Transit Scope"]
            CatchDelivered[Catch Message: Shipment Delivered] --> RestTelemetry[REST Connector: GET IoT Telemetry]
            RestTelemetry --> GwTempCheck{Max Temp > 8°C?}
            GwTempCheck -- "Yes" --> TaskQAInspect[User Task: QA Inspection]
            TaskQAInspect --> GwQAInspect{QA Passed?}
            GwQAInspect -- "No (Default)" --> ErrorQAEnd([Error End Event: SHIPMENT_REJECTED])
            GwTempCheck -- "No (Default)" --> JoinTransit[Join Normal Transit]
            GwQAInspect -- "Yes" --> JoinTransit
        end

        subgraph EventSubProcess ["Event Sub-Process: IoT Excursion Triage"]
            EvStart([Message Start: TempExcursionDetected]) --> RestExcursion[REST: Fetch Excursion Detail]
            RestExcursion --> SlackExcursion[Slack: Alert QA Desk]
            SlackExcursion --> TaskQADecision[User Task: QA Excursion Decision]
            TaskQADecision --> GwExcursion{QA Decision?}
            GwExcursion -- "REJECT" --> ErrorExcursionEnd([Error End: SHIPMENT_REJECTED])
            GwExcursion -- "ACCEPT (Default)" --> EndExcursionOK([End: Excursion Cleared])
        end
    end

    subgraph SettlementPhase ["Settlement & 3-Way Match"]
        JoinTransit --> TaskReceipt[User Task: Confirm Goods Receipt]
        TaskReceipt --> CallActivityMatch[[Call Activity: Supplier Invoice 3-Way Match]]
        CallActivityMatch --> AssembleResult[Assemble Final Shipment Result]
    end

    subgraph CompletionPhase ["Order Summary Notification"]
        AssembleResult --> GwSummary{All Shipments OK?}
        GwSummary -- "Discrepancy / Rejection" --> EmailDiscrepancy[Email Connector: Discrepancy Escalation]
        GwSummary -- "All OK (Default)" --> EmailOK[Email Connector: Success Summary]
        EmailDiscrepancy --> JoinFinal[Join Final Completion]
        EmailOK --> JoinFinal
        JoinFinal --> EndComplete([End: Replenishment Completed])
    end
```

---

## 3. FEEL Expression Dictionary

Every decision rule, mathematical calculation, filtering predicate, and data extraction is implemented in pure, standardized FEEL.

| Expression | Location in Model | Purpose |
| :--- | :--- | :--- |
| `=requestApproved = false` | Sequence flow `Flow_RequestRejected` | Evaluates if the store manager denied the replenishment request at initial review. |
| `=suppliers` | `SubProcess_RFQPerSupplier` (`loopCharacteristics.inputCollection`) | Injects the array of regional dairy and produce suppliers into the parallel RFQ loop. |
| `=supplier` | `SubProcess_RFQPerSupplier` (`loopCharacteristics.inputElement`) | Designates the loop-variable representing the current supplier context. |
| `quotes` | `SubProcess_RFQPerSupplier` (`loopCharacteristics.outputCollection`) | Collects individual quotation results into a process-level collection. |
| `=quote` | `SubProcess_RFQPerSupplier` (`loopCharacteristics.outputElement`) | Maps local instance quote record to the parent aggregation array. |
| `=requestId + "-" + supplier.supplierId` | Subscription correlation key in `Message_QuoteReceived` | Ensures incoming quote messages correlate deterministically to the correct RFQ loop instance. |
| `={ supplierId: supplier.supplierId, price: quotePrice, responded: true }` | `Task_SetReceivedQuote` | Constructs a successful quote object when the supplier responds before timeout. |
| `={ supplierId: supplier.supplierId, price: null, responded: false }` | `Task_SetTimedOutQuote` | Constructs a fallback quote object when the interrupting boundary timer fires. |
| `=count(quotes[item.responded = true]) > 0` | Sequence flow `Flow_ValidQuotesPresent` | Determines whether at least one supplier submitted an active quotation. |
| `=(for q in sort(quotes[item.responded = true], function(x, y) x.price < y.price) return { supplierId: q.supplierId, poNumber: "PO-" + requestId + "-" + q.supplierId, items: items, amount: q.price })[item.amount <= budgetCap]` | `Task_RankSelectSuppliers` (`zeebe:script`) | Filters valid quotes, sorts them ascending by price, transforms into PO objects, and caps by `budgetCap`. |
| `=selectedOrders` | `SubProcess_IssuePurchaseOrders` (`loopCharacteristics.inputCollection`) | Sequential MI input collection of prioritized orders to execute under the budget cap. |
| `poResults` | `SubProcess_IssuePurchaseOrders` (`loopCharacteristics.outputCollection`) | Aggregates issued purchase orders into the collection used for transit fulfilment. |
| `={ poNumber: order.poNumber, supplierId: order.supplierId, items: order.items, amount: order.amount, poStatus: "DISPATCHED" }` | `Task_SetPOResult` | Generates verified purchase order dispatch records. |
| `=poResults` | `SubProcess_ShipmentFulfilment` (`loopCharacteristics.inputCollection`) | Parallel MI input collection triggering independent transit and inspection per PO. |
| `=poResult.poNumber` | Subscription correlation key in `Message_ShipmentDelivered` & `Message_TempExcursionDetected` | Correlates delivery confirmations and IoT telemetry alarms to the specific shipment instance. |
| `=telemetryData.maxTempC > maxTransitTempC` | Sequence flow `Flow_TempExceeded` | Gates whether post-delivery IoT data shows a breach of the 8°C cold-chain ceiling. |
| `=qaInspectionPassed = true` | Sequence flow `Flow_QAInspectionPassed` | Evaluates whether physical dock inspection approved goods despite temperature excursion. |
| `=qaExcursionDecision = "REJECT"` | Sequence flow `Flow_ExcursionReject` | Triggers error end event `SHIPMENT_REJECTED` when QA condemns trailer during transit. |
| `=sum(poResult.items.qty)` | `CallActivity_ThreeWayMatch` input mapping | Dynamically aggregates total authorized items to validate against physical receipt count. |
| `=(receivedQty = orderedQty) and (abs(invoiceAmount - orderedAmount) <= (orderedAmount * 0.02))` | `Task_EvaluateMatch` in child process | Enforces 3-way match rules: exact quantity equality and invoice price within 2% tolerance. |
| `=apDecision = "APPROVE"` | Sequence flow `Flow_APApproved` in child process | Allows accounts payable clerk to approve invoice discrepancy with financial adjustment. |
| `=some r in shipmentResults satisfies r.matchStatus = "DISPUTED" or r.status = "REJECTED" or r.status = "LATE"` | Sequence flow `Flow_ShipmentsDiscrepancy` | Checks if any shipment incurred a quality rejection, late SLA breach, or invoice dispute. |

---

## 4. Repository Structure

```
.
├── bpmn-models/
│   ├── cold-chain-replenishment-main.bpmn      # Main orchestration process (ID: coldChainReplenishment)
│   ├── supplier-invoice-three-way-match.bpmn   # Reusable child process (ID: supplierInvoiceThreeWayMatch)
│   └── forms/                                  # Camunda Form JSON schemas
│       ├── review-replenishment-request.form   # Initial store manager approval
│       ├── qa-inspection.form                  # Post-delivery temperature breach triage
│       ├── qa-decision.form                    # Mid-transit live excursion QA decision
│       ├── confirm-goods-receipt.form          # Receiving dock physical counts & invoice entry
│       └── ap-clerk-manual-review.form         # Accounts payable 3-way match dispute override
├── docs/
│   ├── start-payload.json                      # Reference input JSON payload
│   ├── test-plan.md                            # Complete end-to-end test scenarios & expected states
│   ├── report-ch2-draft.md                     # Academic draft sections 2.1-2.4 and 4.3
│   └── mocks/
│       ├── iot-telemetry-mock.json             # Mock responses for IoT Cold-Chain Telemetry REST API
│       └── supplier-api-mock.json              # Mock responses for Supplier Order REST API
├── .env.example                                # Secret placeholders template for Camunda Connectors
└── README.md                                   # Architecture, setup guide, and FEEL dictionary
```

---

## 5. Deployment and Setup Instructions

### Verified Local Execution on Camunda 8 Run (`D:\Work\Camunda`)

The models and forms in this repository have been fully deployed and verified against the local **Camunda 8 Run (v8.10.0-alpha3)** cluster:
- **Topology**: 1 Broker partition (Leader, Healthy), cluster ID `901f6db7-feab-45e0-a3b1-0795ecb8c671`.
- **Form Deployment**: 5 Camunda Forms deployed (`deploymentKey: 2251799813758757`).
- **Child Process Deployment**: `supplierInvoiceThreeWayMatch` deployed (`processDefinitionKey: 2251799813758753`).
- **Main Process Deployment**: `coldChainReplenishment` deployed (`processDefinitionKey: 2251799813758760`).
- **Instance Execution**: Process instance initiated successfully (`processInstanceKey: 2251799813758761`).

To start the local cluster at any time:
```cmd
cd /d D:\Work\Camunda
camunda-start.bat
```
Web consoles are accessible at:
- **Operate**: `http://localhost:8080/operate` (Credentials: `demo` / `demo`)
- **Tasklist**: `http://localhost:8080/tasklist` (Credentials: `demo` / `demo`)
- **Cluster Orchestration API**: `http://localhost:8080/v2/`

#### Option A: Deploy via Camunda Web Modeler (Recommended)
1. Log into your **Camunda 8 SaaS** or **Camunda 8 Self-Managed** console.
2. Navigate to **Web Modeler** -> Create a new project `Cold Chain Replenishment`.
3. Upload all files:
   - Upload all `.form` files into a `forms/` directory.
   - Upload `supplier-invoice-three-way-match.bpmn`.
   - Upload `cold-chain-replenishment-main.bpmn`.
4. Click **Deploy**:
   - First deploy all 5 forms.
   - Deploy `supplier-invoice-three-way-match.bpmn`.
   - Deploy `cold-chain-replenishment-main.bpmn`.

#### Option B: Deploy via Zeebe CLI (`zbctl`)
```bash
# 1. Deploy Camunda Forms
zbctl deploy bpmn-models/forms/*.form --address <ZEEBE_ADDRESS>

# 2. Deploy Child Process
zbctl deploy bpmn-models/supplier-invoice-three-way-match.bpmn --address <ZEEBE_ADDRESS>

# 3. Deploy Main Orchestration Process
zbctl deploy bpmn-models/cold-chain-replenishment-main.bpmn --address <ZEEBE_ADDRESS>
```

#### Option C: Starting an Instance via Zeebe CLI
```bash
zbctl create instance coldChainReplenishment \
  --variables "$(cat docs/start-payload.json)" \
  --address <ZEEBE_ADDRESS>
```

---

## 6. Outbound Connectors and Secrets Configuration

All external service credentials, endpoints, and authentication tokens are externalized using Camunda's secret expression syntax: `{{secrets.SECRET_NAME}}`. Never hardcode plain text secrets.

### Required Secrets List

| Secret Key | Description | Example Target |
| :--- | :--- | :--- |
| `IOT_API_BASE_URL` | Base URL for IoT Telemetry service | `https://telemetry-mock.internal/api/v1` |
| `IOT_API_TOKEN` | Bearer token for IoT Telemetry API | `mock-iot-telemetry-bearer-token` |
| `SUPPLIER_API_BASE_URL` | Base URL for Regional Supplier API | `https://supplier-portal.internal/api/v1` |
| `SUPPLIER_API_TOKEN` | Bearer token for Supplier API | `mock-supplier-api-bearer-token` |
| `SMTP_HOST` | Outbound SMTP server hostname | `smtp.mailhog.internal` |
| `SMTP_PORT` | SMTP port | `1025` |
| `SMTP_USER` | SMTP authentication username | `procurement@coldchain.internal` |
| `SMTP_PASSWORD` | SMTP password / app key | `secret-smtp-password` |
| `SLACK_BOT_TOKEN` | Bot user OAuth token for Slack app | `xoxb-mock-slack-token` |
| `SLACK_QA_CHANNEL` | Slack channel ID for QA alerts | `C08QACOLDCHAIN` |

### Supplying Secrets in Camunda 8

- **Camunda 8 SaaS**:
  1. Go to **Console** -> **Clusters** -> Select your Cluster.
  2. Click **Connectors** tab -> **Secrets**.
  3. Click **Create Secret** and add each key-value pair from `.env.example`.
- **Camunda 8 Self-Managed / Camunda 8 Run (Docker / Kubernetes)**:
  Provide environment variables prefixed with `CAMUNDA_CONNECTOR_SECRETS_`:
  ```bash
  export CAMUNDA_CONNECTOR_SECRETS_IOT_API_BASE_URL="https://telemetry.internal/api/v1"
  export CAMUNDA_CONNECTOR_SECRETS_IOT_API_TOKEN="token-xyz"
  export CAMUNDA_CONNECTOR_SECRETS_SUPPLIER_API_BASE_URL="https://supplier.internal/api/v1"
  export CAMUNDA_CONNECTOR_SECRETS_SUPPLIER_API_TOKEN="token-abc"
  export CAMUNDA_CONNECTOR_SECRETS_SMTP_HOST="mailhog"
  export CAMUNDA_CONNECTOR_SECRETS_SMTP_PORT="1025"
  export CAMUNDA_CONNECTOR_SECRETS_SMTP_USER="procurement"
  export CAMUNDA_CONNECTOR_SECRETS_SMTP_PASSWORD="password"
  export CAMUNDA_CONNECTOR_SECRETS_SLACK_BOT_TOKEN="xoxb-..."
  export CAMUNDA_CONNECTOR_SECRETS_SLACK_QA_CHANNEL="C08QACOLDCHAIN"
  ```

---

## 7. Assumptions & Engineering Clarifications

1. **Timer Durations**: For academic demonstration, timer events are configured with short ISO 8601 durations (`PT2M` for RFQ quote timeouts and `PT5M` for transit delivery SLAs). In production deployment, these represent `PT4H` (4 hours) and `P2D` (48 hours) respectively.
2. **User Task Implementation**: User tasks leverage native Camunda Form schemas linked via `zeebe:formDefinition formId="..."`. This enables execution in Camunda Tasklist without requiring custom external job workers.
3. **Budget Allocation Logic**: In `Task_RankSelectSuppliers`, suppliers are sorted ascending by quotation amount. The cumulative ranking expression selects orders whose total satisfies `item.amount <= budgetCap`.
4. **Error Propagation**: The `EventSubProcess_TempExcursion` throws an error end event (`SHIPMENT_REJECTED`) when QA condemns a shipment. In BPMN 2.0 semantics, throwing an error inside an event sub-process cancels the enclosing transit scope and catches on `BoundaryEvent_ShipmentRejected`.
