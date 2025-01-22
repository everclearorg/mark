# Fetch available AZs
data "aws_availability_zones" "available" {}

# Create VPC
resource "aws_vpc" "main" {
  cidr_block           = var.cidr_block
  enable_dns_hostnames = true
  enable_dns_support   = true

  tags = {
    Name        = "mark-vpc-${var.environment}-${var.stage}"
    Environment = var.environment
    Stage       = var.stage
    Domain      = var.domain
  }
}

# Create Internet Gateway
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id

  tags = {
    Name        = "mark-igw-${var.environment}-${var.stage}"
    Environment = var.environment
    Stage       = var.stage
    Domain      = var.domain
  }
}

# Public Subnets (map_public_ip_on_launch = true)
resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.main.id
  map_public_ip_on_launch = true
  cidr_block              = cidrsubnet(var.cidr_block, 8, count.index + 2)
  availability_zone       = data.aws_availability_zones.available.names[count.index]

  tags = {
    Name        = "mark-public-${count.index + 1}"
    Environment = var.environment
    Stage       = var.stage
    Domain      = var.domain
  }
}

# Public Route Table
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }

  tags = {
    Name        = "mark-public-rt-${var.environment}-${var.stage}"
    Environment = var.environment
    Stage       = var.stage
    Domain      = var.domain
  }
}

# Associate the Public Route Table with Public Subnets
resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Private Subnets
resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(var.cidr_block, 8, count.index)
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = {
    Name        = "mark-private-${count.index + 1}"
    Environment = var.environment
    Stage       = var.stage
    Domain      = var.domain
  }
}

# NAT Gateway Elastic IP
resource "aws_eip" "nat" {
  count      = 2
  domain     = "vpc"
  depends_on = [aws_internet_gateway.main]
}

# Create NAT Gateway in the FIRST Public Subnet
resource "aws_nat_gateway" "main" {
  count         = 2
  subnet_id     = aws_subnet.public[count.index].id
  allocation_id = aws_eip.nat[count.index].id

  tags = {
    Name        = "mark-nat-${var.environment}-${var.stage}-${count.index + 1}"
    Environment = var.environment
    Stage       = var.stage
    Domain      = var.domain
  }
}

# Separate route table per AZ for private subnets
resource "aws_route_table" "private" {
  count  = 2
  vpc_id = aws_vpc.main.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[count.index].id
  }

  tags = {
    Name        = "mark-private-rt-${var.environment}-${var.stage}-${count.index + 1}"
    Environment = var.environment
    Stage       = var.stage
    Domain      = var.domain
  }
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

variable "vpc_flow_logs_role_arn" {
  description = "ARN of the VPC Flow Logs IAM role"
  type        = string
}

resource "aws_cloudwatch_log_group" "flow_logs_log_group_private_subnets" {
  count = 2  # Since we have 2 subnets
  name  = "vpc-flow-logs-${var.environment}-${var.stage}-${var.domain}-private-${count.index}"
}

resource "aws_cloudwatch_log_group" "flow_logs_log_group_public_subnets" {
  count = 2
  name  = "vpc-flow-logs-${var.environment}-${var.stage}-${var.domain}-public-${count.index}"
}

# VPC Flow Logs for Private Subnets
resource "aws_flow_log" "vpc_flow_logs_private_subnets" {
  count                = 2
  log_destination      = aws_cloudwatch_log_group.flow_logs_log_group_private_subnets[count.index].arn
  log_destination_type = "cloud-watch-logs"
  traffic_type        = "ALL"
  subnet_id           = aws_subnet.private[count.index].id
  iam_role_arn        = var.vpc_flow_logs_role_arn
}

# VPC Flow Logs for Public Subnets
resource "aws_flow_log" "vpc_flow_logs_public_subnets" {
  count                = 2
  log_destination      = aws_cloudwatch_log_group.flow_logs_log_group_public_subnets[count.index].arn
  log_destination_type = "cloud-watch-logs"
  traffic_type        = "ALL"
  subnet_id           = aws_subnet.public[count.index].id
  iam_role_arn        = var.vpc_flow_logs_role_arn
}