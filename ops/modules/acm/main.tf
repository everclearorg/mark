# ACM certificate for a single bot's domains (handler, admin API, prometheus).
# Created in each deployment region (ACM certs are regional).
# DNS validation records are created in the shared everclear.ninja Route53 zone.

locals {
  domain_names = [
    "${var.bot_name}-handler.${var.domain}",
    "admin-${var.bot_name}.${var.domain}",
    "${var.bot_name}-prometheus.${var.domain}",
  ]
  primary_domain    = local.domain_names[0]
  alternative_names = slice(local.domain_names, 1, length(local.domain_names))
}

resource "aws_acm_certificate" "main" {
  domain_name               = local.primary_domain
  subject_alternative_names = local.alternative_names
  validation_method         = "DNS"

  lifecycle {
    create_before_destroy = true
  }

  tags = {
    Name        = "${var.bot_name}-${var.environment}-${var.stage}"
    Environment = var.environment
    Stage       = var.stage
  }
}

resource "aws_route53_record" "validation" {
  for_each = {
    for dvo in aws_acm_certificate.main.domain_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = var.zone_id
}

resource "aws_acm_certificate_validation" "main" {
  certificate_arn         = aws_acm_certificate.main.arn
  validation_record_fqdns = [for record in aws_route53_record.validation : record.fqdn]
}
