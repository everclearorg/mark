## AWS Infra

Mark's infrastructure is deployed on AWS using Terraform and is organized into several modules.


### Directory Structure

ops/
├── env/
│   └── mainnet/
│       ├── secrets.prod.json 
├── mainnet/
│   └── prod/
│       ├── main.tf
│       ├── variables.tf
│       └── config.tf
├── modules/
│   ├── ecs/               # ECS cluster setup
│   ├── iam/               # Roles
│   ├── lambda/            # Lambda function for Mark poller
│   ├── networking/        # Basic VPC/subnet setup
│   ├── service/           # Generic service module for W3S
│   ├── sgs/               # Security groups
└── README.md

### Core Components

1. **Networking (modules/networking)**
   - VPC with public and private subnets across multiple AZs
   - NAT Gateways in each AZ for high availability
   - Internet Gateway for public subnet access
   - Route tables for public/private subnet traffic management

2. **ECS Cluster (modules/ecs)**
   - Fargate-based ECS cluster
   - Task definitions and services
   - Service discovery for internal service communication

3. **Lambda Function (modules/lambda)**
   - Container-based Lambda function for the Mark poller
   - CloudWatch Event trigger
   - VPC integration for private network access

4. **Web3Signer Service (modules/service)**
   - ECS service running Web3Signer
   - Internal DNS resolution via AWS Service Discovery
   - Auto-scaling configuration
   - Health checks and monitoring

### Security

- All services run in private subnets
- Security groups restrict access between services:
  - Web3Signer: Allows port 9000 access only from within VPC
  - Lambda: Allows outbound access to Web3Signer and external APIs
- Secrets management using AWS KMS and SOPS

### Deployment Envs

- mainnet/prod (live prod service)
- mainnet/staging (TBD)
- testnet/prod (TBD)
