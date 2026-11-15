# Project 20: Perishable Cold-Chain Grocery Replenishment

Camunda 8 (Zeebe) workflow solution for automated cold-chain grocery replenishment, coordinating parallel supplier RFQs, price-ranked sequential purchase order dispatches, real-time IoT temperature excursion tracking with non-interrupting event sub-processes, delivery SLA boundary timers, and automated three-way invoice matching via reusable Call Activities.

## Repository Structure

```
Perishable-Cold-Chain-Grocery-Replenishment-Project/
├── .gitignore
├── README.md
└── Backend/
    ├── .env.example
    ├── .gitignore
    ├── README.md                                          # Complete technical specifications & deployment guide
    ├── bpmn-models/
    │   ├── cold-chain-replenishment-main.bpmn             # Main orchestration workflow
    │   ├── supplier-invoice-three-way-match.bpmn          # Three-way invoice match subprocess
    │   └── forms/                                         # Camunda form definitions (v16 schema)
    │       ├── ap-clerk-manual-review.form
    │       ├── confirm-goods-receipt.form
    │       ├── qa-decision.form
    │       ├── qa-inspection.form
    │       └── review-replenishment-request.form
    └── docs/
        ├── report-ch2-draft.md                            # Comprehensive Chapter 2 academic report
        ├── start-payload.json                             # Sample start payload for process instance
        ├── test-plan.md                                   # End-to-end testing matrix & verification plan
        └── mocks/                                         # API payload mocks
            ├── iot-telemetry-mock.json
            └── supplier-api-mock.json
```

## Quick Start & Documentation

For complete architectural specifications, BPMN diagram walkthroughs, FEEL expression dictionaries, secrets configuration, and Zeebe CLI / Desktop Modeler deployment instructions, please refer to the [Backend Documentation](Backend/README.md).
